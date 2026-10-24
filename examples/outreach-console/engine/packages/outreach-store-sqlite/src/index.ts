export { wrapNativeDatabase, TransactionMisuseError, type NativeDatabase } from './driver';
export { migrate, MIGRATIONS, MigrationDriftError, type Migration } from './migrate';
export { openSqliteDatabase, fromBetterSqlite3, type OpenOptions } from './open';
export { SCHEMA_0001 } from './schema';
export { SCHEMA_0002 } from './schema-0002';
export { runDueBackup, BackupError, type BackupConfiguration, type BackupOutcome } from './backup';
