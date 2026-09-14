
    import {
      resolveGatewayBackgroundMaxConcurrency,
      resolveDbQueryPoolSize,
    } from "./src/gateway/services/gatewayBackgroundConcurrency.ts";
    const n = resolveGatewayBackgroundMaxConcurrency();
    if (n < 1 || n > 4) throw new Error("bad concurrency " + n);
    const pool = resolveDbQueryPoolSize();
    if (pool < 1) throw new Error("bad pool");
    console.log("concurrency_ok", n, pool);
  