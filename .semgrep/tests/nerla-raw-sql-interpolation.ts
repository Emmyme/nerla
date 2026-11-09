export async function find(name: string, column: string) {
  // ruleid: nerla-raw-sql-interpolation
  await db.execute(sql.raw(`select * from users where name = '${name}'`))
  // ruleid: nerla-raw-sql-interpolation
  await db.execute(sql.raw("select * from users where name = '" + name + "'"))
  // ruleid: nerla-raw-sql-interpolation
  await client.unsafe(`select ${column} from users`)
  // ruleid: nerla-raw-sql-interpolation
  await client.unsafe("select " + column + " from users", [])
  // ok: nerla-raw-sql-interpolation
  await db.execute(sql`select * from users where name = ${name}`)
  // ok: nerla-raw-sql-interpolation
  await db.execute(sql.raw("select count(*) from users"))
  // ok: nerla-raw-sql-interpolation
  await client.unsafe("select 1")
}
