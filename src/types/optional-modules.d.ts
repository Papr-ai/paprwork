// onnxruntime-node is an optionalDependency: the Mac runs the on-device embedder with it, while the cloud gateway and
// app-host images install with --omit=optional (294 MB native) and use the cloud tier, which never imports it.
// The import is dynamic and typed `any`, so this only keeps tsc green when the package is absent.
declare module "onnxruntime-node";
