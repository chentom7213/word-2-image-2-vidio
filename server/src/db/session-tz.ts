/** DATETIME columns are UTC wall-clock. Session NOW() follows time_zone unless this runs. */
export const UTC_SESSION_SQL = "SET time_zone = '+00:00'";

export async function applyUtcSession(connection: {
  query: (sql: string) => Promise<unknown> | unknown;
}): Promise<void> {
  await connection.query(UTC_SESSION_SQL);
}

export function bindUtcSession(target: {
  on: (
    event: 'connection',
    listener: (connection: { query: (sql: string) => void }) => void,
  ) => void;
}): void {
  target.on('connection', (connection) => {
    connection.query(UTC_SESSION_SQL);
  });
}
