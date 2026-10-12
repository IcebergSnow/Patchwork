import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Exercise actual SQLite queries and constraints, without a remote database. */
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  class Statement {
    constructor(private sql: string, private args: any[] = []) {}
    bind(...args: any[]) { return new Statement(this.sql, args); }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.args) ?? null;
      return column && row ? row[column] : row;
    }
    async all() { return { success:true, results:sqlite.prepare(this.sql).all(...this.args), meta:{} }; }
    async run() {
      const result=sqlite.prepare(this.sql).run(...this.args);
      return { success:true, results:[], meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)} };
    }
  }
  const adapter = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try { const rows=[];for(const statement of statements)rows.push(await statement.run());sqlite.exec('COMMIT');return rows; }
      catch(error){sqlite.exec('ROLLBACK');throw error;}
    },
  };
  return { db:adapter as unknown as D1Database, sqlite };
}
