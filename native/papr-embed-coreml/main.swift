// papr-embed-coreml: a tiny long-lived helper that runs papr-embed-code-1-0.6b on the Apple Neural Engine.
// Protocol: newline-delimited JSON on stdin/stdout.
//   -> {"id":1,"ids":[...token ids incl. <|endoftext|>...]}
//   <- {"id":1,"embedding":[...1024 floats, unit norm...],"fn":"len_64","ms":17.2}
//   <- {"id":1,"error":"..."}
// First line on stdout after load: {"ready":true,"functions":["len_64",...],"load_ms":...,"compiled":bool}
// Usage: papr-embed-coreml <model.mlpackage|model.mlmodelc> [--cpu] [--compile-only]
//   --compile-only: compile + load once (fills the macOS Neural Engine cache), print the ready line, exit.
import CoreML
import Foundation
setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        print(s)
    }
}
let args = CommandLine.arguments
guard args.count >= 2 else { emit(["ready": false, "error": "usage: papr-embed-coreml <model> [--cpu] [--compile-only]"]); exit(2) }
let source = URL(fileURLWithPath: args[1])
// The functions the release model has (multifunction .mlpackage: one set of weights, three fixed lengths).
let lengths = [64, 256, 1024]
let t0 = Date()
var compiled = false

/** Compile the .mlpackage once into a sibling .mlmodelc (atomic move). macOS also caches the Neural Engine plan for
 *  the compiled model, so later launches load in under a second instead of ~2 min. */
func compiledURL(fresh: Bool) throws -> URL {
    guard source.pathExtension == "mlpackage" else { return source }
    let cache = source.deletingPathExtension().appendingPathExtension("mlmodelc")
    if fresh { try? FileManager.default.removeItem(at: cache) }
    if FileManager.default.fileExists(atPath: cache.path) { return cache }
    let tmp = try MLModel.compileModel(at: source)
    try? FileManager.default.removeItem(at: cache)
    try FileManager.default.moveItem(at: tmp, to: cache)
    compiled = true
    return cache
}

/** Load every length in parallel (each is its own Neural Engine program). */
func loadAll(_ url: URL) -> [Int: MLModel] {
    var out: [Int: MLModel] = [:]
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: lengths.count) { i in
        let cfg = MLModelConfiguration()
        cfg.computeUnits = args.contains("--cpu") ? .cpuOnly : .cpuAndNeuralEngine
        cfg.functionName = "len_\(lengths[i])"
        if let m = try? MLModel(contentsOf: url, configuration: cfg) { lock.lock(); out[lengths[i]] = m; lock.unlock() }
    }
    return out
}

var models: [Int: MLModel] = [:]
do {
    models = loadAll(try compiledURL(fresh: false))
    // A cache left by an interrupted or older compile: rebuild it once from the package.
    if models.isEmpty && source.pathExtension == "mlpackage" { models = loadAll(try compiledURL(fresh: true)) }
} catch {
    emit(["ready": false, "error": "compile failed: \(error)"]); exit(1)
}
if models.isEmpty { emit(["ready": false, "error": "no functions loaded"]); exit(1) }
let available = models.keys.sorted()
emit(["ready": true, "functions": available.map { "len_\($0)" }, "load_ms": Int(Date().timeIntervalSince(t0) * 1000), "compiled": compiled])
if args.contains("--compile-only") { exit(0) }

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    let id = req["id"] ?? NSNull()
    guard let ids = req["ids"] as? [Int], !ids.isEmpty else { emit(["id": id, "error": "ids required"]); continue }
    guard let L = available.first(where: { $0 >= ids.count }), let model = models[L] else {
        emit(["id": id, "error": "too long: \(ids.count) tokens, max \(available.last ?? 0)"]); continue
    }
    do {
        let t = Date()
        let input = try MLMultiArray(shape: [1, NSNumber(value: L)], dataType: .int32)
        for i in 0..<L { input[i] = NSNumber(value: i < ids.count ? Int32(ids[i]) : 0) }
        let last = try MLMultiArray(shape: [1], dataType: .int32)
        last[0] = NSNumber(value: Int32(ids.count - 1))
        let feats = try MLDictionaryFeatureProvider(dictionary: ["input_ids": input, "last_index": last])
        let out = try model.prediction(from: feats)
        guard let e = out.featureValue(for: "embedding")?.multiArrayValue else { throw NSError(domain: "embed", code: 1) }
        var v = [Float](repeating: 0, count: e.count)
        for i in 0..<e.count { v[i] = e[i].floatValue }
        emit(["id": id, "embedding": v, "fn": "len_\(L)", "ms": Date().timeIntervalSince(t) * 1000])
    } catch {
        emit(["id": id, "error": "\(error)"])
    }
}
