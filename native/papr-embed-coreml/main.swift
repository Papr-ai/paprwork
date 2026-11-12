// papr-embed-coreml: a tiny long-lived helper that runs papr-embed-code-1-0.6b on the Apple Neural Engine.
// Protocol: newline-delimited JSON on stdin/stdout.
//   -> {"id":1,"ids":[...token ids incl. <|endoftext|>...]}
//   <- {"id":1,"embedding":[...1024 floats, unit norm...],"fn":"len_64","ms":17.2}
//   <- {"id":1,"error":"..."}
// First line on stdout after load: {"ready":true,"functions":["len_64",...],"load_ms":...}
// Usage: papr-embed-coreml <model.mlpackage|model.mlmodelc> [--cpu]
import CoreML
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
        print(s)
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else { emit(["ready": false, "error": "usage: papr-embed-coreml <model> [--cpu]"]); exit(2) }
var url = URL(fileURLWithPath: args[1])
let lengths = [64, 256, 1024, 4096]
let t0 = Date()

do {
    // Compile once; macOS caches the ANE plan for the compiled model, so later launches are fast.
    if url.pathExtension == "mlpackage" {
        let cache = url.deletingPathExtension().appendingPathExtension("mlmodelc")
        if FileManager.default.fileExists(atPath: cache.path) {
            url = cache
        } else {
            let tmp = try MLModel.compileModel(at: url)
            try? FileManager.default.removeItem(at: cache)
            try FileManager.default.moveItem(at: tmp, to: cache)
            url = cache
        }
    }
} catch {
    emit(["ready": false, "error": "compile failed: \(error)"]); exit(1)
}

var models: [Int: MLModel] = [:]
for L in lengths {
    let cfg = MLModelConfiguration()
    cfg.computeUnits = args.contains("--cpu") ? .cpuOnly : .cpuAndNeuralEngine
    cfg.functionName = "len_\(L)"
    if let m = try? MLModel(contentsOf: url, configuration: cfg) { models[L] = m }
}
if models.isEmpty { emit(["ready": false, "error": "no functions loaded"]); exit(1) }
let available = models.keys.sorted()
emit(["ready": true, "functions": available.map { "len_\($0)" }, "load_ms": Int(Date().timeIntervalSince(t0) * 1000)])

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
