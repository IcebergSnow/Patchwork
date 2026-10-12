import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Exercise actual SQLite queries and constraints, without a remote database. */
export function database(migrationCount = Infinity) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort().slice(0, migrationCount)) sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  class Statement {
    constructor(private sql: string, private args: any[] = []) {}
    bind(...args: any[]) { return new Statement(this.sql, args); }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.args) ?? null;
      return column && row ? row[column] : row;
    }
    async all() { return { success:true, results:sqlite.prepare(this.sql).all(...this.args), meta:{} }; }
    run() {
      const result=sqlite.prepare(this.sql).run(...this.args);
      return { success:true, results:[], meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)} };
    }
  }
  const adapter = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const rows=[];for(const statement of statements)rows.push(statement.run());sqlite.exec('COMMIT');return rows; }
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return { db:adapter as unknown as D1Database, sqlite };
}
