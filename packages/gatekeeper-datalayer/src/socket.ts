// The socket postgres.js uses in workerd, in place of its own (postgres/cf/polyfills.js).
//
// Why: the polyfill keeps reading after postgres.js has closed the connection and removed every
// listener, then re-emits the read's "This socket has been closed." as an `error` event that no one
// hears. Node's EventEmitter throws an unheard `error`, so every connection ends in an unhandled
// rejection. This socket is the polyfill's, with one change: an `error` emitted when nothing listens
// is dropped. While a query runs postgres.js always listens, so no failure that matters is lost.
//
// The shape is what postgres.js 3.4.9 and the polyfill's `tls.connect()` (the STARTTLS upgrade)
// read and write: `raw`, `reader`, `writer`, `readyState`, `read()`, `write()`, `end()`,
// `destroy()`, `host`. package.json pins postgres to that version for this reason.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { connect as connectTcp } from "cloudflare:sockets";

type TcpSocket = ReturnType<typeof connectTcp>;

/** What postgres.js passes to its `socket` option: its parsed connection options. */
export type SocketOptions = { host: string[]; port: number[]; ssl: unknown };

type PgSocket = EventEmitter & {
  readyState: string;
  raw: TcpSocket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  host: string;
  destroyed?: boolean;
  read(): Promise<void>;
  write(data: Uint8Array, cb?: () => void): boolean;
  end(data?: Uint8Array): unknown;
  destroy(): void;
};

const CONNECT_TIMEOUT_MS = 10_000;

/** Opens a TCP connection (STARTTLS-capable when `ssl` is set) and returns it once it is open. */
export async function openSocket(options: SocketOptions): Promise<PgSocket> {
  const host = options.host[0]!;
  const port = options.port[0]!;
  const tcp = new EventEmitter() as PgSocket;
  const emit = EventEmitter.prototype.emit;
  tcp.emit = (event: string | symbol, ...args: unknown[]): boolean =>
    event === "error" && tcp.listenerCount("error") === 0 ? false : emit.call(tcp, event, ...args);

  const fail = (error: unknown): void => {
    tcp.emit("error", error);
    tcp.emit("close");
  };
  const close = (): void => {
    if (tcp.readyState === "closed") return;
    tcp.readyState = "closed";
    tcp.emit("close");
  };

  Object.assign(tcp, {
    readyState: "opening",
    host,
    async read() {
      try {
        for (;;) {
          const { done, value } = await tcp.reader.read();
          if (done) break;
          tcp.emit("data", Buffer.from(value));
        }
      } catch (error) {
        fail(error);
      }
    },
    write(data: Uint8Array, cb?: () => void) {
      tcp.writer.write(data).then(cb, fail);
      return true;
    },
    end(data?: Uint8Array) {
      return data ? tcp.write(data, () => void tcp.raw.close()) : tcp.raw.close();
    },
    destroy() {
      tcp.destroyed = true;
      tcp.end();
    },
  });

  tcp.raw = connectTcp({ hostname: host, port }, {
    secureTransport: options.ssl ? "starttls" : "off", allowHalfOpen: false,
  });
  tcp.raw.closed.then(
    () => {
      // The plain socket closes when STARTTLS replaces it; that is the upgrade finishing.
      if (tcp.readyState !== "upgrade") close();
      else { tcp.readyState = "open"; tcp.emit("secureConnect"); }
    },
    fail,
  );
  tcp.writer = tcp.raw.writable.getWriter();
  tcp.reader = tcp.raw.readable.getReader();

  if (options.ssl) {
    // Read only the server's one-byte answer to SSLRequest, leaving the reader free for STARTTLS.
    void (async () => {
      try {
        const { value } = await tcp.reader.read();
        if (value) tcp.emit("data", Buffer.from(value));
      } catch (error) {
        fail(error);
      }
    })();
  } else {
    void tcp.read();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tcp.writer.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out connecting to the database.")), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  tcp.readyState = "open";
  return tcp;
}
