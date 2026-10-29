// JavaIndexer.java - builds a searchable index of every Java file in repos\<name>\.
//
// Run from the ai-context folder (no compiling, no libraries, only Java 17 or newer):
//     java tools/JavaIndexer.java
//     java tools/JavaIndexer.java --repos repos --out generated --threads 4
//
// It only reads files. It writes:
//     generated/index/types.tsv    every class, interface, enum, record and annotation type
//     generated/index/members.tsv  every non-private method and constructor
//     generated/index/refs.tsv     which files use which type (same repo and across repos)
//     generated/index/files.tsv    per file: size, integrations (JMS, REST, JDBC...), SQL tables, config keys, URLs
//     generated/index/enums.tsv    enum types and their constants (often business states)
//     generated/index/throws.tsv   exceptions thrown with a message (often business rules)
//     generated/stats/<repo>.json  counts per repo: naming, packages, tests, frameworks, ...
//     generated/index/meta.json    when and what was indexed
//
// It uses the parser that ships inside the JDK (module jdk.compiler). It does not compile
// anything and does not need the repos to build. Types are matched by name, imports and
// package, not by full compilation, so usage counts are a close estimate, not an exact one.

import com.sun.source.tree.*;
import com.sun.source.util.*;

import javax.lang.model.element.Modifier;
import javax.tools.*;
import java.io.*;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class JavaIndexer {

    // Folders that never hold hand-written source.
    static final Set<String> SKIP_DIRS = Set.of(
            ".git", ".gradle", ".idea", ".vscode", ".settings", "build", "target", "out", "bin",
            "node_modules", ".opencode");
    static final int BATCH = 250;

    public static void main(String[] args) throws Exception {
        Map<String, String> opt = parseArgs(args);
        Path reposDir = Paths.get(opt.getOrDefault("repos", "repos")).toAbsolutePath().normalize();
        Path outDir = Paths.get(opt.getOrDefault("out", "generated")).toAbsolutePath().normalize();
        int threads = Integer.parseInt(opt.getOrDefault("threads",
                String.valueOf(Math.max(1, Math.min(8, Runtime.getRuntime().availableProcessors())))));
        Set<String> only = opt.containsKey("only")
                ? new HashSet<>(Arrays.asList(opt.get("only").split(","))) : null;

        if (!Files.isDirectory(reposDir)) {
            System.err.println("Repos folder not found: " + reposDir);
            System.err.println("Run this from the ai-context folder, or pass --repos <folder>.");
            System.exit(2);
        }
        if (javax.tools.ToolProvider.getSystemJavaCompiler() == null) {
            System.err.println("This Java has no compiler (a JRE, not a JDK). Use a JDK 17 or newer.");
            System.exit(2);
        }

        long t0 = System.currentTimeMillis();
        List<String> repoNames = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(reposDir)) {
            for (Path p : ds) {
                if (!Files.isDirectory(p)) continue;
                String n = p.getFileName().toString();
                if (n.startsWith(".")) continue;
                if (only != null && !only.contains(n)) continue;
                repoNames.add(n);
            }
        }
        Collections.sort(repoNames);
        if (repoNames.isEmpty()) {
            System.err.println("No repo folders found in " + reposDir);
            System.exit(2);
        }

        // 1. Find files and cut them into batches.
        List<Batch> batches = new ArrayList<>();
        Map<String, RepoStats> stats = new LinkedHashMap<>();
        for (String repo : repoNames) {
            List<Path> files = listJavaFiles(reposDir.resolve(repo));
            stats.put(repo, new RepoStats(repo));
            for (int i = 0; i < files.size(); i += BATCH)
                batches.add(new Batch(repo, reposDir, files.subList(i, Math.min(files.size(), i + BATCH))));
            System.out.printf("  %-40s %6d java files%n", repo, files.size());
        }

        // 2. Parse in parallel. Each batch gets its own parser.
        ExecutorService pool = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r);
            t.setDaemon(true); // never keep Java running after an error
            return t;
        });
        List<Future<BatchResult>> futures = new ArrayList<>();
        for (Batch b : batches) futures.add(pool.submit(b::run));
        List<FileRec> allFiles = new ArrayList<>();
        List<TypeRec> allTypes = new ArrayList<>();
        List<MemberRec> allMembers = new ArrayList<>();
        List<EnumRec> allEnums = new ArrayList<>();
        List<ThrowRec> allThrows = new ArrayList<>();
        int done = 0;
        for (Future<BatchResult> f : futures) {
            BatchResult r = f.get();
            allFiles.addAll(r.files);
            allTypes.addAll(r.types);
            allMembers.addAll(r.members);
            allEnums.addAll(r.enums);
            allThrows.addAll(r.throwsList);
            stats.get(r.repo).merge(r.stats);
            done++;
            if (done % 20 == 0 || done == futures.size())
                System.out.printf("  parsed %d/%d batches%n", done, futures.size());
        }
        pool.shutdown();

        // 3. Work out who uses which type.
        Map<String, List<TypeRec>> bySimple = new HashMap<>();
        Map<String, TypeRec> byFqn = new HashMap<>();
        for (TypeRec t : allTypes) {
            bySimple.computeIfAbsent(t.simple, k -> new ArrayList<>()).add(t);
            byFqn.putIfAbsent(t.fqn, t);
        }
        // Which repo owns which package (for "this repo uses code from repo X").
        Map<String, Set<String>> pkgOwners = new HashMap<>();
        for (TypeRec t : allTypes) pkgOwners.computeIfAbsent(t.pkg, k -> new TreeSet<>()).add(t.repo);

        Path indexDir = outDir.resolve("index");
        Files.createDirectories(indexDir);
        Files.createDirectories(outDir.resolve("stats"));
        long refCount = 0;
        // owning repo -> using repo -> files
        Map<String, Map<String, Set<String>>> usedBy = new HashMap<>();
        try (BufferedWriter refs = Files.newBufferedWriter(indexDir.resolve("refs.tsv"), StandardCharsets.UTF_8)) {
            refs.write("fqn\trepo\tfile\n");
            for (FileRec f : allFiles) {
                Set<TypeRec> used = new LinkedHashSet<>();
                for (String id : f.ids) {
                    List<TypeRec> cands = bySimple.get(id);
                    if (cands == null) continue;
                    for (TypeRec t : cands) {
                        if (t.file.equals(f.path) && t.repo.equals(f.repo)) continue;
                        if (visible(t, f)) used.add(t);
                    }
                }
                for (TypeRec t : used) {
                    t.usedByFiles++;
                    if (!t.repo.equals(f.repo)) {
                        t.usedByRepos.add(f.repo);
                        t.usedByOtherRepoFiles++;
                        usedBy.computeIfAbsent(t.repo, k -> new TreeMap<>())
                              .computeIfAbsent(f.repo, k -> new HashSet<>()).add(f.path);
                    }
                    refs.write(t.fqn + "\t" + f.repo + "\t" + f.path + "\n");
                    refCount++;
                }
                // Imports of packages that belong to another repo.
                Set<String> otherRepos = new TreeSet<>();
                for (String imp : f.imports) {
                    String pkg = packageOfImport(imp, byFqn);
                    Set<String> owners = pkgOwners.get(pkg);
                    if (owners != null && !owners.contains(f.repo)) otherRepos.addAll(owners);
                }
                for (String w : f.wildcards) {
                    Set<String> owners = pkgOwners.get(w);
                    if (owners != null && !owners.contains(f.repo)) otherRepos.addAll(owners);
                }
                RepoStats rs = stats.get(f.repo);
                for (String o : otherRepos) rs.usesRepos.merge(o, 1, Integer::sum);
            }
        }

        // 4. Write the type and member tables.
        try (BufferedWriter w = Files.newBufferedWriter(indexDir.resolve("types.tsv"), StandardCharsets.UTF_8)) {
            w.write("fqn\tname\tkind\trepo\tfile\tline\tmods\textends\timplements\tannotations\tusedByFiles\tusedByRepos\tdoc\n");
            for (TypeRec t : allTypes) {
                w.write(String.join("\t", t.fqn, t.simple, t.kind, t.repo, t.file, String.valueOf(t.line),
                        t.mods, t.ext, String.join(",", t.impls), String.join(";", t.annotations),
                        String.valueOf(t.usedByFiles), String.join(",", t.usedByRepos), t.doc));
                w.write("\n");
            }
        }
        try (BufferedWriter w = Files.newBufferedWriter(indexDir.resolve("members.tsv"), StandardCharsets.UTF_8)) {
            w.write("type\tname\tkind\trepo\tfile\tline\tmods\tsignature\tannotations\n");
            for (MemberRec m : allMembers) {
                w.write(String.join("\t", m.typeFqn, m.name, m.kind, m.repo, m.file, String.valueOf(m.line),
                        m.mods, m.signature, String.join(";", m.annotations)));
                w.write("\n");
            }
        }

        try (BufferedWriter w = Files.newBufferedWriter(indexDir.resolve("files.tsv"), StandardCharsets.UTF_8)) {
            w.write("repo\tfile\tpkg\ttest\tlines\tintegrations\tsqlTables\tconfigKeys\turls\n");
            for (FileRec f : allFiles) {
                String tables = f.sqlTables.entrySet().stream().limit(40).map(e -> e.getKey() + ":" + e.getValue()).collect(Collectors.joining(","));
                w.write(String.join("\t", f.repo, f.path, f.pkg, f.test ? "1" : "0", String.valueOf(f.lines),
                        String.join(",", f.integrations), tables,
                        f.configKeys.stream().limit(40).collect(Collectors.joining(",")),
                        f.urls.stream().limit(10).collect(Collectors.joining(","))));
                w.write("\n");
            }
        }
        try (BufferedWriter w = Files.newBufferedWriter(indexDir.resolve("enums.tsv"), StandardCharsets.UTF_8)) {
            w.write("fqn\trepo\tfile\tline\tconstants\n");
            for (EnumRec e : allEnums)
                w.write(String.join("\t", e.fqn(), e.repo(), e.file(), String.valueOf(e.line()),
                        e.constants().stream().limit(60).collect(Collectors.joining(","))) + "\n");
        }
        try (BufferedWriter w = Files.newBufferedWriter(indexDir.resolve("throws.tsv"), StandardCharsets.UTF_8)) {
            w.write("repo\tfile\tline\ttype\tmethod\texception\tmessage\n");
            for (ThrowRec t : allThrows)
                w.write(String.join("\t", t.repo(), t.file(), String.valueOf(t.line()), t.type(), t.method(), t.exception(), t.message()) + "\n");
        }

        // 5. Per-repo statistics.
        for (RepoStats rs : stats.values()) {
            for (Map.Entry<String, Set<String>> e : usedBy.getOrDefault(rs.repo, Map.of()).entrySet())
                rs.usedByRepos.put(e.getKey(), e.getValue().size());
            rs.finish();
            Files.writeString(outDir.resolve("stats").resolve(rs.repo + ".json"), rs.json, StandardCharsets.UTF_8);
        }

        long secs = (System.currentTimeMillis() - t0) / 1000;
        StringBuilder meta = new StringBuilder();
        meta.append("{\n  \"indexedAt\": ").append(q(java.time.Instant.now().toString()))
            .append(",\n  \"seconds\": ").append(secs)
            .append(",\n  \"files\": ").append(allFiles.size())
            .append(",\n  \"types\": ").append(allTypes.size())
            .append(",\n  \"members\": ").append(allMembers.size())
            .append(",\n  \"refs\": ").append(refCount)
            .append(",\n  \"repos\": [");
        int i = 0;
        for (String r : repoNames) meta.append(i++ == 0 ? "" : ", ").append(q(r));
        meta.append("]\n}\n");
        Files.writeString(indexDir.resolve("meta.json"), meta.toString(), StandardCharsets.UTF_8);

        int errFiles = stats.values().stream().mapToInt(s -> s.parseErrorFiles).sum();
        System.out.printf("Indexed %d repos, %d files, %d types, %d methods in %d s.%n",
                repoNames.size(), allFiles.size(), allTypes.size(), allMembers.size(), secs);
        if (errFiles > 0)
            System.out.printf("%d files had syntax the parser did not fully understand; they are indexed as far as possible.%n", errFiles);
        System.out.println("Output: " + outDir);
    }

    /** Is type t reachable by simple name from file f? */
    static boolean visible(TypeRec t, FileRec f) {
        if (t.pkg.equals(f.pkg) && t.outer == null) return true;
        if (f.imports.contains(t.fqn)) return true;
        if (f.wildcards.contains(t.pkg) && t.outer == null) return true;
        if (t.outer != null) {
            // Nested type: Outer.Inner via import of Outer, same package, or a wildcard on Outer.
            if (f.imports.contains(t.outer) || f.wildcards.contains(t.outer)) return true;
            if (t.pkg.equals(f.pkg)) return true;
            if (f.wildcards.contains(t.pkg)) return true;
        }
        return f.qualified.contains(t.fqn);
    }

    static String packageOfImport(String imp, Map<String, TypeRec> byFqn) {
        TypeRec t = byFqn.get(imp);
        if (t != null) return t.pkg;
        int dot = imp.lastIndexOf('.');
        return dot > 0 ? imp.substring(0, dot) : imp;
    }

    static List<Path> listJavaFiles(Path root) throws IOException {
        List<Path> out = new ArrayList<>();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes a) {
                if (!dir.equals(root) && SKIP_DIRS.contains(dir.getFileName().toString())) return FileVisitResult.SKIP_SUBTREE;
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes a) {
                if (file.getFileName().toString().endsWith(".java") && a.isRegularFile()) out.add(file);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult visitFileFailed(Path file, IOException e) { return FileVisitResult.CONTINUE; }
        });
        Collections.sort(out);
        return out;
    }

    static Map<String, String> parseArgs(String[] args) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if (a.equals("-h") || a.equals("--help")) {
                System.out.println("Usage: java tools/JavaIndexer.java [--repos repos] [--out generated] [--threads N] [--only repoA,repoB]");
                System.exit(0);
            }
            if (a.startsWith("--") && i + 1 < args.length) m.put(a.substring(2), args[++i]);
        }
        return m;
    }

    // ------------------------------------------------------------------ records

    static final class FileRec {
        String repo, path, pkg = "";
        boolean test;
        int lines;
        Set<String> imports = new HashSet<>(), wildcards = new HashSet<>(), ids = new HashSet<>(), qualified = new HashSet<>();
        Set<String> integrations = new TreeSet<>(), configKeys = new TreeSet<>(), urls = new TreeSet<>();
        Map<String, Integer> sqlTables = new TreeMap<>();
    }

    record EnumRec(String fqn, String repo, String file, int line, List<String> constants) {}
    record ThrowRec(String repo, String file, int line, String type, String method, String exception, String message) {}

    static final class TypeRec {
        String fqn, simple, kind, repo, file, pkg, outer, mods = "", ext = "", doc = "";
        int line;
        boolean test, isPublic;
        List<String> impls = new ArrayList<>(), annotations = new ArrayList<>();
        int usedByFiles, usedByOtherRepoFiles;
        Set<String> usedByRepos = new TreeSet<>();
    }

    static final class MemberRec {
        String typeFqn, name, kind, repo, file, mods, signature;
        int line;
        List<String> annotations = new ArrayList<>();
    }

    record Batch(String repo, Path reposDir, List<Path> files) {
        BatchResult run() {
            BatchResult res = new BatchResult(repo);
            Path repoRoot = reposDir.resolve(repo);
            JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
            List<JavaFileObject> objs = new ArrayList<>();
            Map<URI, Path> paths = new HashMap<>();
            Map<URI, String> texts = new HashMap<>();
            for (Path p : files) {
                try {
                    String text = decode(Files.readAllBytes(p));
                    URI uri = p.toUri();
                    objs.add(new Src(uri, text));
                    paths.put(uri, p);
                    texts.put(uri, text);
                } catch (IOException e) {
                    // unreadable file: skip
                }
            }
            Set<URI> errorFiles = new HashSet<>();
            DiagnosticListener<JavaFileObject> diags = d -> {
                if (d.getKind() == Diagnostic.Kind.ERROR && d.getSource() != null) errorFiles.add(d.getSource().toUri());
            };
            JavacTask task = (JavacTask) javac.getTask(new StringWriter(), null, diags,
                    List.of("-proc:none", "-nowarn", "-XDsuppressNotes"), null, objs);
            Iterable<? extends CompilationUnitTree> units;
            try {
                units = task.parse();
            } catch (Throwable e) {
                System.err.println("Parser failed on a batch in " + repo + ": " + e);
                return res;
            }
            Trees trees = Trees.instance(task);
            for (CompilationUnitTree cu : units) {
                URI uri = cu.getSourceFile().toUri();
                Path p = paths.get(uri);
                if (p == null) continue;
                String rel = repoRoot.relativize(p).toString().replace('\\', '/');
                String text = texts.get(uri);
                int lines = text.isEmpty() ? 0 : (int) text.chars().filter(c -> c == '\n').count() + 1;
                boolean test = isTestPath(rel);
                FileRec f = new FileRec();
                f.repo = repo;
                f.path = rel;
                f.test = test;
                f.lines = lines;
                if (cu.getPackageName() != null) f.pkg = cu.getPackageName().toString();
                for (ImportTree it : cu.getImports()) {
                    String s = it.getQualifiedIdentifier().toString();
                    if (it.isStatic()) {
                        int d = s.lastIndexOf('.');
                        if (d > 0) f.imports.add(s.substring(0, d)); // the class holding the static member
                        continue;
                    }
                    if (s.endsWith(".*")) f.wildcards.add(s.substring(0, s.length() - 2));
                    else f.imports.add(s);
                    String kind = integrationOf(s);
                    if (kind != null) f.integrations.add(kind);
                }
                res.stats.addFile(f, lines, test, errorFiles.contains(uri), cu);
                try {
                    new Scanner(res, f, cu, trees, text).scan(cu, null);
                } catch (RuntimeException | StackOverflowError e) {
                    System.err.println("  could not fully read " + repo + "/" + rel + ": " + e);
                }
                res.files.add(f);
            }
            return res;
        }
    }

    static final class BatchResult {
        final String repo;
        final List<FileRec> files = new ArrayList<>();
        final List<TypeRec> types = new ArrayList<>();
        final List<MemberRec> members = new ArrayList<>();
        final List<EnumRec> enums = new ArrayList<>();
        final List<ThrowRec> throwsList = new ArrayList<>();
        final RepoStats stats;
        BatchResult(String repo) { this.repo = repo; this.stats = new RepoStats(repo); }
    }

    static final class Src extends SimpleJavaFileObject {
        final String text;
        Src(URI uri, String text) { super(uri, Kind.SOURCE); this.text = text; }
        @Override public CharSequence getCharContent(boolean ignore) { return text; }
    }

    /** UTF-8 if valid, otherwise Windows-1252 (common in older code bases). */
    static String decode(byte[] bytes) {
        int start = (bytes.length >= 3 && (bytes[0] & 0xff) == 0xEF && (bytes[1] & 0xff) == 0xBB && (bytes[2] & 0xff) == 0xBF) ? 3 : 0;
        ByteBuffer bb = ByteBuffer.wrap(bytes, start, bytes.length - start);
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(bb).toString();
        } catch (CharacterCodingException e) {
            return new String(bytes, start, bytes.length - start, Charset.forName("windows-1252"));
        }
    }

    static boolean isTestPath(String rel) {
        String r = "/" + rel.toLowerCase(java.util.Locale.ROOT);
        if (r.contains("/src/main/")) return false;
        return r.contains("/src/test") || r.contains("/src/integrationtest/") || r.contains("/src/testfixtures/")
                || r.contains("/src/it/") || r.contains("/test/") || r.contains("/tests/") || r.contains("-tests/")
                || r.contains("/unittest/") || r.contains("/integrationtest/");
    }

    // ------------------------------------------------------------------ the tree walk

    static final class Scanner extends TreePathScanner<Void, Void> {
        final BatchResult res;
        final FileRec f;
        final CompilationUnitTree cu;
        final Trees trees;
        final SourcePositions pos;
        final String text;
        final LinkedList<TypeRec> typeStack = new LinkedList<>(); // may hold null for anonymous classes
        boolean sawLambda, sawSwitchExpr, sawRecord, sawVar;
        final Deque<String> methodStack = new ArrayDeque<>();

        Scanner(BatchResult res, FileRec f, CompilationUnitTree cu, Trees trees, String text) {
            this.res = res; this.f = f; this.cu = cu; this.trees = trees; this.pos = trees.getSourcePositions(); this.text = text;
        }

        int line(Tree t) {
            long p = pos.getStartPosition(cu, t);
            return p < 0 ? 0 : (int) cu.getLineMap().getLineNumber(p);
        }

        @Override public Void scan(Tree tree, Void v) {
            Void r = super.scan(tree, v);
            if (tree == cu) {
                RepoStats s = res.stats;
                if (sawLambda) s.filesWithLambdas++;
                if (sawSwitchExpr) s.filesWithSwitchExpr++;
                if (sawRecord) s.filesWithRecords++;
                if (sawVar) s.filesWithVar++;
            }
            return r;
        }

        @Override public Void visitClass(ClassTree ct, Void v) {
            String name = ct.getSimpleName().toString();
            if (name.isEmpty()) { // anonymous class: no record, but look inside
                typeStack.push(null);
                try { return super.visitClass(ct, v); } finally { typeStack.pop(); }
            }
            TypeRec parent = typeStack.peek();
            TypeRec t = new TypeRec();
            t.simple = name;
            t.repo = f.repo;
            t.file = f.path;
            t.pkg = f.pkg;
            t.test = f.test;
            t.line = line(ct);
            t.outer = parent != null ? parent.fqn : null;
            boolean localClass = parent == null && !typeStack.isEmpty(); // inside an anonymous class or method
            String prefix = parent != null ? parent.fqn : (f.pkg.isEmpty() ? "" : f.pkg + ".");
            t.fqn = parent != null ? prefix + "." + name : prefix + name;
            t.kind = switch (ct.getKind()) {
                case INTERFACE -> "interface";
                case ENUM -> "enum";
                case ANNOTATION_TYPE -> "annotation";
                case RECORD -> "record";
                default -> "class";
            };
            if (ct.getKind() == Tree.Kind.RECORD) sawRecord = true;
            Set<Modifier> mods = ct.getModifiers().getFlags();
            t.isPublic = mods.contains(Modifier.PUBLIC);
            t.mods = modString(mods);
            if (ct.getExtendsClause() != null) t.ext = plainType(ct.getExtendsClause().toString());
            for (Tree i : ct.getImplementsClause()) t.impls.add(plainType(i.toString()));
            t.annotations.addAll(annotations(ct.getModifiers()));
            String doc = trees.getDocComment(getCurrentPath());
            t.doc = summary(doc);
            if (!localClass) {
                res.types.add(t);
                res.stats.addType(t, doc != null && !doc.isBlank());
            }
            for (String a : t.annotations) res.stats.addAnnotation(a, f.test);
            if (!localClass && ct.getKind() == Tree.Kind.ENUM) {
                List<String> constants = new ArrayList<>();
                for (Tree m : ct.getMembers()) {
                    if (m instanceof VariableTree vt && vt.getInitializer() instanceof NewClassTree
                            && vt.getType() != null && plainType(vt.getType().toString()).equals(name))
                        constants.add(vt.getName().toString());
                }
                if (!constants.isEmpty()) res.enums.add(new EnumRec(t.fqn, f.repo, f.path, t.line, constants));
            }
            typeStack.push(localClass ? null : t);
            try { return super.visitClass(ct, v); } finally { typeStack.pop(); }
        }

        @Override public Void visitMethod(MethodTree mt, Void v) {
            TypeRec owner = typeStack.peek();
            List<String> anns = annotations(mt.getModifiers());
            for (String a : anns) res.stats.addAnnotation(a, f.test);
            if (owner != null) {
                Set<Modifier> mods = mt.getModifiers().getFlags();
                boolean ctor = mt.getName().contentEquals("<init>");
                String mname = ctor ? owner.simple : mt.getName().toString();
                boolean isTestMethod = anns.stream().anyMatch(a -> a.equals("@Test") || a.startsWith("@Test(")
                        || a.equals("@ParameterizedTest") || a.startsWith("@ParameterizedTest("))
                        || (f.test && mname.startsWith("test") && mods.contains(Modifier.PUBLIC) && mt.getParameters().isEmpty());
                if (isTestMethod) res.stats.addTestMethod(mname);
                if (!ctor && mods.contains(Modifier.STATIC) && mname.equals("main") && mt.getParameters().size() == 1
                        && mt.getParameters().get(0).getType().toString().replace(" ", "").matches("(final)?String(\\[\\]|\\.\\.\\.)")) {
                    res.stats.entryPoints.add(owner.fqn + "\t" + owner.file + "\t" + line(mt) + "\tmain method" + (f.test ? " (test code)" : ""));
                }
                if (!mods.contains(Modifier.PRIVATE)) {
                    MemberRec m = new MemberRec();
                    m.typeFqn = owner.fqn;
                    m.name = mname;
                    m.kind = ctor ? "ctor" : "method";
                    m.repo = f.repo;
                    m.file = f.path;
                    m.line = line(mt);
                    m.mods = modString(mods);
                    StringBuilder sig = new StringBuilder(mname).append('(');
                    int i = 0;
                    for (VariableTree p : mt.getParameters()) {
                        if (i++ > 0) sig.append(", ");
                        sig.append(p.getType() == null ? "?" : plainType(p.getType().toString())).append(' ').append(p.getName());
                    }
                    sig.append(')');
                    if (!ctor && mt.getReturnType() != null) sig.append(": ").append(plainType(mt.getReturnType().toString()));
                    m.signature = clean(sig.toString());
                    m.annotations.addAll(anns);
                    res.members.add(m);
                }
            }
            methodStack.push(mt.getName().contentEquals("<init>") ? "<init>" : mt.getName().toString());
            try { return super.visitMethod(mt, v); } finally { methodStack.pop(); }
        }

        @Override public Void visitVariable(VariableTree vt, Void v) {
            TreePath parentPath = getCurrentPath().getParentPath();
            Tree parent = parentPath == null ? null : parentPath.getLeaf();
            List<String> anns = annotations(vt.getModifiers());
            for (String a : anns) res.stats.addAnnotation(a, f.test);
            if (parent instanceof ClassTree && vt.getType() != null) {
                String type = plainType(vt.getType().toString());
                String simple = type.contains(".") ? type.substring(type.lastIndexOf('.') + 1) : type;
                if (simple.equals("Logger") || simple.equals("Log") || simple.equals("XLogger") || simple.equals("ILogger"))
                    res.stats.loggerFields.merge(simple + " " + vt.getName(), 1, Integer::sum);
            } else if (vt.getType() == null && vt.getInitializer() != null && !(parent instanceof LambdaExpressionTree)) {
                sawVar = true; // local variable declared with 'var'
            }
            return super.visitVariable(vt, v);
        }

        @Override public Void visitIdentifier(IdentifierTree it, Void v) {
            f.ids.add(it.getName().toString());
            return super.visitIdentifier(it, v);
        }

        @Override public Void visitMemberSelect(MemberSelectTree ms, Void v) {
            String n = ms.getIdentifier().toString();
            f.ids.add(n);
            // Fully qualified use without an import, e.g. com.acme.order.Order
            if (!n.isEmpty() && Character.isUpperCase(n.charAt(0))) {
                ExpressionTree e = ms.getExpression();
                Tree leftmost = e;
                while (leftmost instanceof MemberSelectTree m) leftmost = m.getExpression();
                if (leftmost instanceof IdentifierTree id && e instanceof MemberSelectTree) {
                    String first = id.getName().toString();
                    if (!first.isEmpty() && Character.isLowerCase(first.charAt(0))) f.qualified.add(ms.toString());
                }
            }
            return super.visitMemberSelect(ms, v);
        }

        @Override public Void visitThrow(ThrowTree tt, Void v) {
            if (!f.test && tt.getExpression() instanceof NewClassTree nc) {
                String ex = plainType(nc.getIdentifier().toString());
                if (ex.contains(".")) ex = ex.substring(ex.lastIndexOf('.') + 1);
                String msg = messageOf(nc.getArguments());
                TypeRec owner = typeStack.peek();
                res.throwsList.add(new ThrowRec(f.repo, f.path, line(tt), owner == null ? "" : owner.fqn,
                        methodStack.isEmpty() ? "" : methodStack.peek(), ex, msg == null ? "" : msg));
            }
            return super.visitThrow(tt, v);
        }

        @Override public Void visitLiteral(LiteralTree lt, Void v) {
            if (lt.getValue() instanceof String str && !f.test) {
                TreePath parent = getCurrentPath().getParentPath();
                boolean inConcat = parent != null && parent.getLeaf().getKind() == Tree.Kind.PLUS;
                if (!inConcat) noteString(str);
            }
            return super.visitLiteral(lt, v);
        }

        @Override public Void visitBinary(BinaryTree bt, Void v) {
            if (bt.getKind() == Tree.Kind.PLUS && !f.test) {
                TreePath parent = getCurrentPath().getParentPath();
                boolean top = parent == null || parent.getLeaf().getKind() != Tree.Kind.PLUS;
                if (top) {
                    StringBuilder sb = new StringBuilder();
                    if (joinLiterals(bt, sb)) noteString(sb.toString());
                }
            }
            return super.visitBinary(bt, v);
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree mi, Void v) {
            if (!f.test && !mi.getArguments().isEmpty() && mi.getArguments().get(0) instanceof LiteralTree lt
                    && lt.getValue() instanceof String key) {
                String name = mi.getMethodSelect() instanceof MemberSelectTree ms ? ms.getIdentifier().toString()
                        : mi.getMethodSelect().toString();
                if (CONFIG_GETTERS.contains(name) && CONFIG_KEY.matcher(key).matches() && !SYSTEM_PROPERTY.matcher(key).find()) f.configKeys.add(key);
            }
            return super.visitMethodInvocation(mi, v);
        }

        /** Concatenated string literals; non-literal parts become "?". False if there is no literal at all. */
        boolean joinLiterals(ExpressionTree e, StringBuilder sb) {
            if (e instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS) {
                boolean l = joinLiterals(b.getLeftOperand(), sb), r = joinLiterals(b.getRightOperand(), sb);
                return l || r;
            }
            if (e instanceof ParenthesizedTree pt) return joinLiterals(pt.getExpression(), sb);
            if (e instanceof LiteralTree lt && lt.getValue() instanceof String str) { sb.append(str); return true; }
            sb.append('?');
            return false;
        }

        void noteString(String str) {
            if (str.length() < 6) return;
            java.util.regex.Matcher pm = PLACEHOLDER.matcher(str);
            while (pm.find()) f.configKeys.add(pm.group(1));
            java.util.regex.Matcher um = URL.matcher(str);
            while (um.find()) f.urls.add(um.group(1));
            if (SQL.matcher(str).find()) {
                java.util.regex.Matcher tm = SQL_TABLE.matcher(str);
                while (tm.find()) {
                    String table = tm.group(1);
                    if (table.equals("?") || table.equalsIgnoreCase("dual") || table.length() < 2) continue;
                    f.sqlTables.merge(table, 1, Integer::sum);
                }
            }
        }

        @Override public Void visitLambdaExpression(LambdaExpressionTree lt, Void v) {
            sawLambda = true;
            return super.visitLambdaExpression(lt, v);
        }

        @Override public Void visitSwitchExpression(SwitchExpressionTree st, Void v) {
            sawSwitchExpr = true;
            return super.visitSwitchExpression(st, v);
        }
    }

    // ------------------------------------------------------------------ helpers

    static final Pattern PLACEHOLDER = Pattern.compile("\\$\\{([A-Za-z][\\w.\\-]*)(?::[^}]*)?}");
    static final Pattern URL = Pattern.compile("https?://([A-Za-z0-9.\\-]+(?::\\d+)?)");
    static final Pattern SQL = Pattern.compile("(?is)^\\s*(select\\s.+\\sfrom\\s|insert\\s+into\\s|update\\s+\\S+\\s+set\\s|delete\\s+from\\s|merge\\s+into\\s|with\\s+\\w+\\s+as\\s*\\()|\\s(from|join)\\s+[A-Za-z_][\\w.$]*\\s+(where|join|inner|left|order|group|on)\\s");
    static final Pattern SQL_TABLE = Pattern.compile("(?i)\\b(?:from|join|into|update|merge\\s+into)\\s+([A-Za-z_][\\w$]*(?:\\.[A-Za-z_][\\w$]*)?)");
    static final Pattern CONFIG_KEY = Pattern.compile("[A-Za-z][\\w\\-]*(\\.[A-Za-z0-9_\\-]+)+");
    static final Pattern SYSTEM_PROPERTY = Pattern.compile("^(java|javax|jdk|sun|user|os|file|line|path)\\.");
    static final Set<String> CONFIG_GETTERS = Set.of("getProperty", "getString", "getInt", "getInteger", "getLong",
            "getBoolean", "getDouble", "getRequiredProperty", "getValue", "getConfig", "getSetting", "getParameter", "getenv");

    /** What kind of outside system a file talks to, judged from one import. Null if none. */
    static String integrationOf(String imp) {
        String s = imp;
        String[][] rules = {
            {"javax.jms.", "JMS"}, {"jakarta.jms.", "JMS"}, {"org.springframework.jms.", "JMS"}, {"com.ibm.mq.", "IBM MQ"}, {"com.ibm.msg.", "IBM MQ"},
            {"org.apache.kafka.", "Kafka"}, {"org.springframework.kafka.", "Kafka"},
            {"com.rabbitmq.", "RabbitMQ"}, {"org.springframework.amqp.", "RabbitMQ"},
            {"javax.ws.rs.client.", "REST client"}, {"jakarta.ws.rs.client.", "REST client"}, {"org.springframework.web.client.", "REST client"},
            {"org.springframework.web.reactive.function.client.", "REST client"}, {"java.net.http.", "REST client"}, {"org.apache.http.", "REST client"},
            {"org.apache.hc.", "REST client"}, {"okhttp3.", "REST client"}, {"feign.", "REST client"}, {"retrofit2.", "REST client"},
            {"com.sun.jersey.api.client.", "REST client"}, {"org.glassfish.jersey.client.", "REST client"}, {"java.net.HttpURLConnection", "REST client"},
            {"javax.ws.rs.", "REST endpoint"}, {"jakarta.ws.rs.", "REST endpoint"}, {"org.springframework.web.bind.annotation.", "REST endpoint"},
            {"javax.servlet.", "Servlet"}, {"jakarta.servlet.", "Servlet"},
            {"javax.xml.ws.", "SOAP"}, {"jakarta.xml.ws.", "SOAP"}, {"javax.jws.", "SOAP"}, {"jakarta.jws.", "SOAP"}, {"org.apache.cxf.", "SOAP"}, {"org.springframework.ws.", "SOAP"}, {"org.apache.axis", "SOAP"},
            {"javax.persistence.", "JPA"}, {"jakarta.persistence.", "JPA"}, {"org.hibernate.", "Hibernate"},
            {"java.sql.", "JDBC"}, {"javax.sql.", "JDBC"}, {"org.springframework.jdbc.", "JDBC"}, {"org.jooq.", "jOOQ"},
            {"org.apache.ibatis.", "MyBatis"}, {"org.mybatis.", "MyBatis"},
            {"javax.mail.", "Mail"}, {"jakarta.mail.", "Mail"}, {"org.apache.commons.net.", "FTP"}, {"com.jcraft.jsch.", "SFTP"},
            {"org.quartz.", "Quartz"}, {"org.springframework.scheduling.", "Scheduling"}, {"org.springframework.batch.", "Spring Batch"},
            {"javax.ejb.", "EJB"}, {"jakarta.ejb.", "EJB"}, {"java.rmi.", "RMI"}, {"javax.naming.", "JNDI/LDAP"}, {"org.springframework.ldap.", "JNDI/LDAP"},
            {"redis.clients.", "Redis"}, {"org.springframework.data.redis.", "Redis"}, {"net.sf.ehcache.", "Cache"}, {"javax.cache.", "Cache"},
            {"org.elasticsearch.", "Elasticsearch"}, {"com.mongodb.", "MongoDB"}, {"org.springframework.data.mongodb.", "MongoDB"},
            {"javax.xml.bind.", "XML binding"}, {"jakarta.xml.bind.", "XML binding"}, {"org.apache.poi.", "Excel/Office files"},
            {"com.itextpdf.", "PDF"}, {"org.apache.pdfbox.", "PDF"}, {"net.sf.jasperreports.", "Reports"}
        };
        for (String[] r : rules) if (s.startsWith(r[0]) || s.equals(r[0])) return r[1];
        return null;
    }

    static final Pattern GENERICS = Pattern.compile("<[^<>]*>");
    static final Pattern TYPE_ANNOS = Pattern.compile("@[\\w.]+(\\([^)]*\\))?\\s*");

    /** "java.util.List<Map<String,Foo>>" -> "java.util.List"; drops type annotations. */
    static String plainType(String s) {
        String r = TYPE_ANNOS.matcher(s).replaceAll("");
        String prev;
        do { prev = r; r = GENERICS.matcher(r).replaceAll(""); } while (!r.equals(prev));
        return clean(r.trim());
    }

    static String clean(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            b.append(c < 0x20 || c == 0x7f ? ' ' : c);
        }
        return b.toString();
    }

    static String modString(Set<Modifier> mods) {
        List<String> out = new ArrayList<>();
        for (Modifier m : List.of(Modifier.PUBLIC, Modifier.PROTECTED, Modifier.ABSTRACT, Modifier.STATIC, Modifier.FINAL))
            if (mods.contains(m)) out.add(m.toString());
        return String.join(" ", out);
    }

    /** Annotations as "@Name" or "@Name(\"first string argument\")". */
    static List<String> annotations(ModifiersTree mt) {
        List<String> out = new ArrayList<>();
        for (AnnotationTree a : mt.getAnnotations()) {
            String name = a.getAnnotationType().toString();
            if (name.contains(".")) name = name.substring(name.lastIndexOf('.') + 1);
            String arg = firstString(a.getArguments());
            out.add(arg == null ? "@" + name : "@" + name + "(\"" + arg + "\")");
        }
        return out;
    }

    static String firstString(List<? extends ExpressionTree> args) {
        for (ExpressionTree e : args) {
            String s = stringIn(e);
            if (s != null) {
                s = clean(s).replace(';', ',').replace('"', '\'');
                return s.length() > 100 ? s.substring(0, 100) + "..." : s;
            }
        }
        return null;
    }

    /** The first argument that holds text, with non-text parts shown as an ellipsis: "Order " + id + " not found" -> "Order ... not found". */
    static String messageOf(List<? extends ExpressionTree> args) {
        for (ExpressionTree e : args) {
            StringBuilder sb = new StringBuilder();
            if (textOf(e, sb)) {
                String m = clean(sb.toString()).replaceAll("(\u2026\\s*)+\u2026", "\u2026").trim();
                return m.length() > 160 ? m.substring(0, 157) + "..." : m;
            }
        }
        return null;
    }

    static boolean textOf(ExpressionTree e, StringBuilder sb) {
        if (e instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS) {
            boolean l = textOf(b.getLeftOperand(), sb), r = textOf(b.getRightOperand(), sb);
            return l || r;
        }
        if (e instanceof ParenthesizedTree pt) return textOf(pt.getExpression(), sb);
        if (e instanceof LiteralTree lt && lt.getValue() instanceof String str) { sb.append(str); return true; }
        if (e instanceof MethodInvocationTree mi && mi.getMethodSelect().toString().endsWith("format") && !mi.getArguments().isEmpty())
            return textOf(mi.getArguments().get(0), sb);
        sb.append('\u2026');
        return false;
    }

    static String stringIn(ExpressionTree e) {
        if (e instanceof AssignmentTree as) return stringIn(as.getExpression());
        if (e instanceof LiteralTree lt && lt.getValue() instanceof String s) return s;
        if (e instanceof NewArrayTree na && na.getInitializers() != null)
            for (ExpressionTree i : na.getInitializers()) { String s = stringIn(i); if (s != null) return s; }
        if (e instanceof BinaryTree bt) { // "a" + "b"
            String l = stringIn(bt.getLeftOperand()), r = stringIn(bt.getRightOperand());
            if (l != null || r != null) return (l == null ? "" : l) + (r == null ? "" : r);
        }
        return null;
    }

    static final Pattern INLINE_TAG = Pattern.compile("\\{@\\w+\\s+([^}]*)}");
    static final Pattern HTML_TAG = Pattern.compile("<[^>]+>");

    /** First sentence of a Javadoc comment, plain text, at most 160 characters. */
    static String summary(String doc) {
        if (doc == null) return "";
        String s = doc;
        int at = s.indexOf("\n@");
        if (at >= 0) s = s.substring(0, at);
        if (s.trim().startsWith("@")) return "";
        s = INLINE_TAG.matcher(s).replaceAll("$1");
        s = HTML_TAG.matcher(s).replaceAll(" ");
        s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        s = s.replaceAll("\\s+", " ").trim();
        int dot = -1;
        for (int i = 0; i < s.length() - 1; i++)
            if (s.charAt(i) == '.' && Character.isWhitespace(s.charAt(i + 1))) { dot = i; break; }
        if (dot > 0) s = s.substring(0, dot + 1);
        if (s.length() > 160) s = s.substring(0, 157) + "...";
        return clean(s);
    }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> { if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); }
            }
        }
        return b.append('"').toString();
    }

    // ------------------------------------------------------------------ statistics per repo

    static final class RepoStats {
        final String repo;
        int files, mainFiles, testFiles, lines, mainLines, testLines, parseErrorFiles;
        int filesWithLambdas, filesWithSwitchExpr, filesWithRecords, filesWithVar;
        int publicTypes, publicTypesWithDoc;
        final Map<String, Integer> kinds = new TreeMap<>();
        final Map<String, Integer> packages = new HashMap<>();      // main code: package -> files
        final Map<String, Integer> importGroups = new HashMap<>();  // library prefix -> files
        final Map<String, Integer> annotations = new HashMap<>();   // main code
        final Map<String, Integer> testAnnotations = new HashMap<>();
        final Map<String, Integer> loggerFields = new HashMap<>();
        final Map<String, Integer> testMethodStyles = new HashMap<>();
        final Map<String, Integer> testClassSuffix = new HashMap<>();
        final Map<String, Integer> testFrameworks = new HashMap<>();
        final Map<String, Integer> usesRepos = new TreeMap<>();
        final Map<String, Integer> usedByRepos = new TreeMap<>();
        final List<String> entryPoints = new ArrayList<>();
        final List<String[]> fileSizes = new ArrayList<>();        // path, lines
        final List<TypeRec> mainTypes = new ArrayList<>();
        // filled by finish()
        String json;

        RepoStats(String repo) { this.repo = repo; }

        void addFile(FileRec f, int lines, boolean test, boolean parseError, CompilationUnitTree cu) {
            files++;
            this.lines += lines;
            if (test) { testFiles++; testLines += lines; } else { mainFiles++; mainLines += lines; packages.merge(f.pkg, 1, Integer::sum); }
            if (parseError) parseErrorFiles++;
            fileSizes.add(new String[]{f.path, String.valueOf(lines)});
            Set<String> groups = new HashSet<>();
            for (ImportTree it : cu.getImports()) groups.add(importGroup(it.getQualifiedIdentifier().toString()));
            for (String g : groups) importGroups.merge(g, 1, Integer::sum);
            if (test) {
                Set<String> fw = new HashSet<>();
                for (ImportTree it : cu.getImports()) {
                    String s = it.getQualifiedIdentifier().toString();
                    if (s.startsWith("org.junit.jupiter")) fw.add("JUnit 5");
                    else if (s.startsWith("org.junit.") || s.equals("junit.framework.TestCase") || s.startsWith("junit.framework")) fw.add("JUnit 4 or 3");
                    else if (s.startsWith("org.testng")) fw.add("TestNG");
                    else if (s.startsWith("org.mockito")) fw.add("Mockito");
                    else if (s.startsWith("org.easymock")) fw.add("EasyMock");
                    else if (s.startsWith("org.powermock")) fw.add("PowerMock");
                    else if (s.startsWith("org.jmock")) fw.add("jMock");
                    else if (s.startsWith("org.assertj")) fw.add("AssertJ");
                    else if (s.startsWith("org.hamcrest")) fw.add("Hamcrest");
                    else if (s.startsWith("com.google.common.truth")) fw.add("Truth");
                    else if (s.startsWith("org.springframework.test") || s.startsWith("org.springframework.boot.test")) fw.add("Spring Test");
                    else if (s.startsWith("org.testcontainers")) fw.add("Testcontainers");
                    else if (s.startsWith("io.restassured")) fw.add("REST Assured");
                    else if (s.startsWith("org.dbunit")) fw.add("DbUnit");
                    else if (s.startsWith("com.github.tomakehurst.wiremock") || s.startsWith("org.wiremock")) fw.add("WireMock");
                }
                for (String x : fw) testFrameworks.merge(x, 1, Integer::sum);
            }
        }

        void addType(TypeRec t, boolean hasDoc) {
            kinds.merge(t.kind + (t.test ? " (test)" : ""), 1, Integer::sum);
            if (t.test) {
                if (t.outer == null) {
                    String sfx = t.simple.endsWith("IT") ? "IT" : t.simple.endsWith("Tests") ? "Tests"
                            : t.simple.endsWith("Test") ? "Test" : t.simple.endsWith("TestCase") ? "TestCase"
                            : t.simple.endsWith("Spec") ? "Spec" : "other";
                    testClassSuffix.merge(sfx, 1, Integer::sum);
                }
                return;
            }
            mainTypes.add(t);
            if (t.isPublic && t.outer == null) {
                publicTypes++;
                if (hasDoc) publicTypesWithDoc++;
            }
            if (t.ext.endsWith("HttpServlet")) entryPoints.add(t.fqn + "\t" + t.file + "\t" + t.line + "\tservlet (extends " + t.ext + ")");
            for (String a : t.annotations) {
                String n = a.contains("(") ? a.substring(0, a.indexOf('(')) : a;
                if (n.endsWith("Application") || n.equals("@WebServlet") || n.equals("@WebListener") || n.equals("@MessageDriven")
                        || n.equals("@Startup") || n.equals("@ApplicationPath"))
                    entryPoints.add(t.fqn + "\t" + t.file + "\t" + t.line + "\tannotated " + a);
            }
        }

        void addAnnotation(String a, boolean test) {
            String n = a.contains("(") ? a.substring(0, a.indexOf('(')) : a;
            (test ? testAnnotations : annotations).merge(n, 1, Integer::sum);
        }

        void addTestMethod(String name) {
            String style;
            if (name.contains("_")) style = "with_underscores";
            else if (name.startsWith("test")) style = "testSomething";
            else if (name.startsWith("should")) style = "shouldSomething";
            else if (name.startsWith("given") || name.startsWith("when")) style = "givenWhenThen";
            else style = "plain camelCase";
            testMethodStyles.merge(style, 1, Integer::sum);
        }

        void merge(RepoStats o) {
            files += o.files; mainFiles += o.mainFiles; testFiles += o.testFiles;
            lines += o.lines; mainLines += o.mainLines; testLines += o.testLines;
            parseErrorFiles += o.parseErrorFiles;
            filesWithLambdas += o.filesWithLambdas; filesWithSwitchExpr += o.filesWithSwitchExpr;
            filesWithRecords += o.filesWithRecords; filesWithVar += o.filesWithVar;
            publicTypes += o.publicTypes; publicTypesWithDoc += o.publicTypesWithDoc;
            for (var m : List.of(
                    List.of(kinds, o.kinds), List.of(packages, o.packages), List.of(importGroups, o.importGroups),
                    List.of(annotations, o.annotations), List.of(testAnnotations, o.testAnnotations),
                    List.of(loggerFields, o.loggerFields), List.of(testMethodStyles, o.testMethodStyles),
                    List.of(testClassSuffix, o.testClassSuffix), List.of(testFrameworks, o.testFrameworks)))
                for (Map.Entry<String, Integer> e : m.get(1).entrySet()) m.get(0).merge(e.getKey(), e.getValue(), Integer::sum);
            entryPoints.addAll(o.entryPoints);
            fileSizes.addAll(o.fileSizes);
            mainTypes.addAll(o.mainTypes);
        }

        static String importGroup(String s) {
            String[] p = s.split("\\.");
            if (p.length <= 2) return s;
            return p[0] + "." + p[1];
        }

        static String suffixOf(String name) {
            // last CamelCase word, or the last two when the last one is Impl / Bean / Test
            List<String> words = new ArrayList<>();
            int start = 0;
            for (int i = 1; i < name.length(); i++) {
                char c = name.charAt(i), prev = name.charAt(i - 1);
                boolean boundary = Character.isUpperCase(c) && (Character.isLowerCase(prev) || Character.isDigit(prev)
                        || (i + 1 < name.length() && Character.isLowerCase(name.charAt(i + 1)) && Character.isUpperCase(prev)));
                if (boundary) { words.add(name.substring(start, i)); start = i; }
            }
            words.add(name.substring(start));
            if (words.size() == 1) return null;
            String last = words.get(words.size() - 1);
            if (words.size() >= 3 && Set.of("Impl", "Bean", "Default").contains(last))
                return words.get(words.size() - 2) + last;
            return last;
        }

        void finish() {
            // Name endings of main-code types.
            Map<String, Integer> suffixes = new HashMap<>();
            Map<String, String> suffixExample = new HashMap<>();
            int interfaces = 0, iPrefixed = 0, implClasses = 0, abstractClasses = 0, abstractPrefixed = 0;
            Map<String, Integer> exceptionBases = new HashMap<>();
            int customExceptions = 0;
            for (TypeRec t : mainTypes) {
                String s = suffixOf(t.simple);
                if (s != null) {
                    suffixes.merge(s, 1, Integer::sum);
                    suffixExample.merge(s, t.simple, (a, b) -> a.length() <= b.length() ? a : b);
                }
                if (t.kind.equals("interface")) {
                    interfaces++;
                    if (t.simple.length() > 2 && t.simple.charAt(0) == 'I' && Character.isUpperCase(t.simple.charAt(1))
                            && Character.isLowerCase(t.simple.charAt(2))) iPrefixed++;
                }
                if (t.kind.equals("class") && t.simple.endsWith("Impl")) implClasses++;
                if (t.mods.contains("abstract") && t.kind.equals("class")) {
                    abstractClasses++;
                    if (t.simple.startsWith("Abstract") || t.simple.startsWith("Base")) abstractPrefixed++;
                }
                if (t.simple.endsWith("Exception") && t.kind.equals("class")) {
                    customExceptions++;
                    exceptionBases.merge(t.ext.isEmpty() ? "(nothing)" : simpleName(t.ext), 1, Integer::sum);
                }
            }

            StringBuilder b = new StringBuilder("{\n");
            field(b, "repo", q(repo));
            field(b, "files", files); field(b, "mainFiles", mainFiles); field(b, "testFiles", testFiles);
            field(b, "lines", lines); field(b, "mainLines", mainLines); field(b, "testLines", testLines);
            field(b, "parseErrorFiles", parseErrorFiles);
            b.append("  \"kinds\": ").append(mapJson(kinds, 50)).append(",\n");
            b.append("  \"rootPackage\": ").append(q(commonPrefix(packages.keySet()))).append(",\n");
            b.append("  \"packages\": ").append(topList(packages, 30, "name", "files")).append(",\n");
            b.append("  \"suffixes\": [");
            int i = 0;
            for (Map.Entry<String, Integer> e : top(suffixes, 30)) {
                if (e.getValue() < 2) continue;
                b.append(i++ == 0 ? "\n    " : ",\n    ").append("{\"suffix\": ").append(q(e.getKey()))
                 .append(", \"count\": ").append(e.getValue()).append(", \"example\": ").append(q(suffixExample.get(e.getKey()))).append("}");
            }
            b.append("\n  ],\n");
            b.append("  \"naming\": {\"interfaces\": ").append(interfaces).append(", \"interfacesStartingWithI\": ").append(iPrefixed)
             .append(", \"classesEndingInImpl\": ").append(implClasses).append(", \"abstractClasses\": ").append(abstractClasses)
             .append(", \"abstractStartingWithAbstractOrBase\": ").append(abstractPrefixed).append("},\n");
            b.append("  \"exceptions\": {\"custom\": ").append(customExceptions).append(", \"extend\": ").append(mapJson(sortDesc(exceptionBases, 8), 8)).append("},\n");
            b.append("  \"loggerFields\": ").append(topList(loggerFields, 8, "field", "count")).append(",\n");
            b.append("  \"annotations\": ").append(topList(annotations, 40, "name", "count")).append(",\n");
            b.append("  \"testAnnotations\": ").append(topList(testAnnotations, 15, "name", "count")).append(",\n");
            b.append("  \"importGroups\": ").append(topList(importGroups, 40, "prefix", "files")).append(",\n");
            b.append("  \"tests\": {\"classSuffix\": ").append(mapJson(sortDesc(testClassSuffix, 10), 10))
             .append(", \"methodStyles\": ").append(mapJson(sortDesc(testMethodStyles, 10), 10))
             .append(", \"frameworks\": ").append(mapJson(sortDesc(testFrameworks, 20), 20)).append("},\n");
            b.append("  \"language\": {\"filesWithLambdas\": ").append(filesWithLambdas)
             .append(", \"filesWithVar\": ").append(filesWithVar)
             .append(", \"filesWithRecords\": ").append(filesWithRecords)
             .append(", \"filesWithSwitchExpressions\": ").append(filesWithSwitchExpr).append("},\n");
            b.append("  \"javadoc\": {\"publicTopLevelTypes\": ").append(publicTypes).append(", \"withJavadoc\": ").append(publicTypesWithDoc).append("},\n");
            b.append("  \"usesRepos\": ").append(mapJson(sortDesc(usesRepos, 100), 100)).append(",\n");
            b.append("  \"usedByRepos\": ").append(mapJson(sortDesc(usedByRepos, 100), 100)).append(",\n");
            // entry points
            b.append("  \"entryPoints\": [");
            i = 0;
            Set<String> seenEp = new HashSet<>();
            entryPoints.sort(Comparator.comparing((String ep) -> ep.contains("(test code)")).thenComparing(ep -> ep));
            for (String ep : entryPoints) {
                String[] p = ep.split("\t");
                if (!seenEp.add(p[0] + p[3])) continue;
                if (i >= 25) break;
                b.append(i++ == 0 ? "\n    " : ",\n    ").append("{\"type\": ").append(q(p[0])).append(", \"file\": ").append(q(p[1]))
                 .append(", \"line\": ").append(p[2]).append(", \"why\": ").append(q(p[3])).append("}");
            }
            b.append("\n  ],\n");
            // most used types inside the repo (main code)
            List<TypeRec> core = mainTypes.stream().filter(t -> t.outer == null)
                    .sorted(Comparator.comparingInt((TypeRec t) -> -(t.usedByFiles)).thenComparing(t -> t.fqn)).limit(25).collect(Collectors.toList());
            b.append("  \"coreTypes\": ").append(typeList(core)).append(",\n");
            List<TypeRec> api = mainTypes.stream().filter(t -> t.usedByOtherRepoFiles > 0)
                    .sorted(Comparator.comparingInt((TypeRec t) -> -(t.usedByOtherRepoFiles)).thenComparing(t -> t.fqn)).limit(20).collect(Collectors.toList());
            b.append("  \"usedByOtherReposTypes\": ").append(typeList(api)).append(",\n");
            fileSizes.sort(Comparator.comparingInt((String[] a) -> -Integer.parseInt(a[1])));
            b.append("  \"largestFiles\": [");
            for (i = 0; i < Math.min(10, fileSizes.size()); i++)
                b.append(i == 0 ? "\n    " : ",\n    ").append("{\"file\": ").append(q(fileSizes.get(i)[0])).append(", \"lines\": ").append(fileSizes.get(i)[1]).append("}");
            b.append("\n  ],\n");
            b.append("  \"suggestedFiles\": ").append(suggested(core)).append("\n");
            b.append("}\n");
            json = b.toString();
        }

        /** A handful of files that show what the repo is about and how it is written. */
        String suggested(List<TypeRec> core) {
            LinkedHashMap<String, String> picks = new LinkedHashMap<>();
            for (String ep : entryPoints) {
                if (picks.size() >= 3) break;
                if (ep.contains("(test code)")) continue;
                String[] p = ep.split("\t");
                picks.putIfAbsent(p[1], "entry point: " + p[3]);
            }
            for (TypeRec t : core) {
                if (picks.size() >= 10) break;
                picks.putIfAbsent(t.file, "most used type " + t.simple + " (used in " + t.usedByFiles + " files)");
            }
            // one typical file from each of the biggest packages
            List<Map.Entry<String, Integer>> bigPkgs = top(packages, 8);
            for (Map.Entry<String, Integer> e : bigPkgs) {
                if (picks.size() >= 16) break;
                mainTypes.stream().filter(t -> t.pkg.equals(e.getKey()) && t.outer == null)
                        .max(Comparator.comparingInt((TypeRec t) -> t.usedByFiles).thenComparing(t -> t.fqn))
                        .ifPresent(t -> picks.putIfAbsent(t.file, "typical file in package " + e.getKey()));
            }
            StringBuilder b = new StringBuilder("[");
            int i = 0;
            for (Map.Entry<String, String> e : picks.entrySet())
                b.append(i++ == 0 ? "\n    " : ",\n    ").append("{\"file\": ").append(q(e.getKey())).append(", \"why\": ").append(q(e.getValue())).append("}");
            return b.append("\n  ]").toString();
        }

        static String typeList(List<TypeRec> ts) {
            StringBuilder b = new StringBuilder("[");
            int i = 0;
            for (TypeRec t : ts)
                b.append(i++ == 0 ? "\n    " : ",\n    ").append("{\"type\": ").append(q(t.fqn)).append(", \"kind\": ").append(q(t.kind))
                 .append(", \"usedByFiles\": ").append(t.usedByFiles).append(", \"usedByOtherRepoFiles\": ").append(t.usedByOtherRepoFiles)
                 .append(", \"file\": ").append(q(t.file)).append(", \"doc\": ").append(q(t.doc)).append("}");
            return b.append(ts.isEmpty() ? "]" : "\n  ]").toString();
        }

        static String simpleName(String s) { return s.contains(".") ? s.substring(s.lastIndexOf('.') + 1) : s; }

        static void field(StringBuilder b, String k, Object v) { b.append("  ").append(q(k)).append(": ").append(v).append(",\n"); }

        static List<Map.Entry<String, Integer>> top(Map<String, Integer> m, int n) {
            return m.entrySet().stream()
                    .sorted(Map.Entry.<String, Integer>comparingByValue().reversed().thenComparing(Map.Entry.comparingByKey()))
                    .limit(n).collect(Collectors.toList());
        }

        static Map<String, Integer> sortDesc(Map<String, Integer> m, int n) {
            LinkedHashMap<String, Integer> out = new LinkedHashMap<>();
            for (Map.Entry<String, Integer> e : top(m, n)) out.put(e.getKey(), e.getValue());
            return out;
        }

        static String mapJson(Map<String, Integer> m, int n) {
            StringBuilder b = new StringBuilder("{");
            int i = 0;
            for (Map.Entry<String, Integer> e : m.entrySet()) {
                if (i >= n) break;
                b.append(i++ == 0 ? "" : ", ").append(q(e.getKey())).append(": ").append(e.getValue());
            }
            return b.append("}").toString();
        }

        static String topList(Map<String, Integer> m, int n, String k, String v) {
            StringBuilder b = new StringBuilder("[");
            int i = 0;
            for (Map.Entry<String, Integer> e : top(m, n))
                b.append(i++ == 0 ? "" : ", ").append("{").append(q(k)).append(": ").append(q(e.getKey())).append(", ").append(q(v)).append(": ").append(e.getValue()).append("}");
            return b.append("]").toString();
        }

        static String commonPrefix(Collection<String> pkgs) {
            List<String> l = pkgs.stream().filter(s -> !s.isEmpty()).sorted().collect(Collectors.toList());
            if (l.isEmpty()) return "";
            String[] first = l.get(0).split("\\."), last = l.get(l.size() - 1).split("\\.");
            List<String> out = new ArrayList<>();
            for (int i = 0; i < Math.min(first.length, last.length) && first[i].equals(last[i]); i++) out.add(first[i]);
            return String.join(".", out);
        }
    }
}
