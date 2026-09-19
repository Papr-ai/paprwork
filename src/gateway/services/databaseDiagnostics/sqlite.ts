import type Database from "better-sqlite3";
import { DatabaseConnectionTrace, databaseTracingEnabled, sqlOperationKind } from "./trace.js";

const connectionFinalizer = new FinalizationRegistry<DatabaseConnectionTrace>(trace => trace.close());
const cursorFinalizer = new FinalizationRegistry<() => void>(end => end());

/** Preserve the native constructor, return values, errors and transaction semantics. */
export function openDiagnosticDatabase(
  Constructor: typeof Database, owner: string, filename?: string | Buffer, options?: Database.Options,
): Database.Database {
  if (!databaseTracingEnabled()) return new Constructor(filename, options);
  const trace = new DatabaseConnectionTrace(typeof filename === "string" ? filename : ":memory:", owner, "better-sqlite3");
  const opened = trace.begin("open");
  let db: Database.Database;
  try { db = new Constructor(filename, options); opened(); }
  catch (error) { opened(error); trace.close(); throw error; }
  connectionFinalizer.register(db, trace, db);
  const invoke = <T>(kind: string, fn: () => T): T => {
    const end = trace.begin(kind);
    try { const result = fn(); trace.transaction(db.open && db.inTransaction); end(); return result; }
    catch (error) { trace.transaction(db.open && db.inTransaction); end(error); throw error; }
  };
  const prepared = new WeakSet<object>();
  const wrapStatement = (stmt: Database.Statement, kind: string): Database.Statement => {
    if (prepared.has(stmt)) return stmt;
    prepared.add(stmt);
    for (const method of ["all", "get", "run"] as const) {
      const original = stmt[method];
      Object.defineProperty(stmt, method, { configurable: true, writable: true,
        value: function (...args: unknown[]) { return invoke(`${method}:${kind}`, () => original.apply(stmt, args)); } });
    }
    const iterate = stmt.iterate;
    Object.defineProperty(stmt, "iterate", { configurable: true, writable: true, value: function (...args: unknown[]) {
      const iterator = iterate.apply(stmt, args);
      const end = trace.begin(`cursor:${kind}`);
      const wrapper: IterableIterator<unknown> = {
        [Symbol.iterator]() { return this; },
        next(...values: [] | [unknown]) {
          try { const result = invoke(`cursor-next:${kind}`, () => iterator.next(...values)); if (result.done) { end(); cursorFinalizer.unregister(wrapper); } return result; }
          catch (error) { end(error); throw error; }
        },
        return(value?: unknown) { try { return iterator.return ? iterator.return(value) : { done: true as const, value }; } finally { end(); cursorFinalizer.unregister(wrapper); } },
        throw(error?: unknown) { try { if (iterator.throw) return iterator.throw(error); throw error; } finally { end(error); cursorFinalizer.unregister(wrapper); } },
      };
      cursorFinalizer.register(wrapper, end, wrapper);
      return wrapper;
    } });
    return stmt;
  };
  const prepare = db.prepare;
  db.prepare = ((sql: string) => wrapStatement(invoke(`prepare:${sqlOperationKind(sql)}`, () => prepare.call(db, sql)), sqlOperationKind(sql))) as typeof db.prepare;
  const exec = db.exec;
  db.exec = (sql: string) => invoke(`exec:${sqlOperationKind(sql)}`, () => exec.call(db, sql));
  const pragma = db.pragma;
  db.pragma = ((...args: Parameters<typeof pragma>) => invoke("pragma", () => pragma.apply(db, args))) as typeof pragma;
  const transaction = db.transaction;
  db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    if (typeof fn !== "function") return transaction.call(db, fn);
    const endPrepare = trace.begin("transaction-prepare");
    let raw: ReturnType<typeof transaction>;
    try { raw = transaction.call(db, function (this: unknown, ...args: unknown[]) {
      trace.transaction(db.inTransaction); return fn.apply(this, args);
    }); endPrepare(); } catch (error) { endPrepare(error); throw error; }
    const cache = new WeakMap<Function, Function>();
    const wrap = (target: Function): Function => {
      const existing = cache.get(target); if (existing) return existing;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        return invoke("transaction", () => Reflect.apply(target, this, args));
      };
      cache.set(target, wrapped);
      for (const key of ["default", "deferred", "immediate", "exclusive", "database"]) {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor) Object.defineProperty(wrapped, key, { ...descriptor,
          value: key === "database" ? descriptor.value : wrap(descriptor.value) });
      }
      return wrapped;
    };
    return wrap(raw);
  }) as typeof db.transaction;
  const close = db.close;
  db.close = () => { const result = invoke("close", () => close.call(db)); trace.close(); connectionFinalizer.unregister(db); return result; };
  return db;
}
