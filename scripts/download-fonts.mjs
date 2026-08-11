import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const GOOGLE_FONTS_COMMIT = "038b637da7b3fd956a4ed93ffc607c3d5e4ce172";
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 20081;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  {
    name: "Inter-Variable.ttf",
    directory: path.join("src", "assets", "fonts"),
    source: `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf`,
    sha256: "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031",
  },
  {
    name: "Inter-OFL.txt",
    directory: path.join("public", "licenses", "fonts"),
    source: `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/inter/OFL.txt`,
    sha256: "5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57",
  },
  {
    name: "NotoSansSC-Variable.ttf",
    directory: path.join("src", "assets", "fonts"),
    source: `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf`,
    sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
  },
  {
    name: "NotoSansSC-OFL.txt",
    directory: path.join("public", "licenses", "fonts"),
    source: `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/ofl/notosanssc/OFL.txt`,
    sha256: "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  },
];

function socketReader(socket) {
  let buffer = Buffer.alloc(0);
  const waiters = [];
  let failure;

  const flush = () => {
    while (waiters.length > 0 && buffer.length >= waiters[0].length) {
      const waiter = waiters.shift();
      const value = buffer.subarray(0, waiter.length);
      buffer = buffer.subarray(waiter.length);
      waiter.resolve(value);
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on("error", (error) => {
    failure = error;
    while (waiters.length > 0) waiters.shift().reject(error);
  });
  socket.on("end", () => {
    const error = failure ?? new Error("SOCKS5 proxy closed the connection");
    while (waiters.length > 0) waiters.shift().reject(error);
  });

  return (length) => {
    if (failure) return Promise.reject(failure);
    if (buffer.length >= length) {
      const value = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      waiters.push({ length, resolve, reject });
    });
  };
}

async function connectThroughSocks(hostname, port) {
  const socket = net.createConnection({ host: PROXY_HOST, port: PROXY_PORT });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const read = socketReader(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await read(2);
  if (greeting[0] !== 0x05 || greeting[1] !== 0x00) {
    throw new Error(`SOCKS5 authentication negotiation failed: ${greeting.toString("hex")}`);
  }

  const host = Buffer.from(hostname, "utf8");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));

  const reply = await read(4);
  if (reply[0] !== 0x05 || reply[1] !== 0x00) {
    throw new Error(`SOCKS5 connection failed with status 0x${reply[1].toString(16)}`);
  }

  if (reply[3] === 0x01) await read(4);
  else if (reply[3] === 0x03) await read((await read(1))[0]);
  else if (reply[3] === 0x04) await read(16);
  else throw new Error(`SOCKS5 proxy returned unknown address type 0x${reply[3].toString(16)}`);
  await read(2);

  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: hostname });
    secureSocket.once("secureConnect", () => resolve(secureSocket));
    secureSocket.once("error", reject);
  });
}

function decodeChunkedBody(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) throw new Error("Invalid chunked response");
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0], 16);
    if (!Number.isFinite(size)) throw new Error("Invalid chunk size");
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function download(url, redirectCount = 0) {
  if (redirectCount > 5) throw new Error(`Too many redirects while downloading ${url}`);
  const target = new URL(url);
  const socket = await connectThroughSocks(target.hostname, Number(target.port || 443));

  socket.write([
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "User-Agent: Cockpit-Tools-font-downloader/1.0",
    "Accept: */*",
    "Connection: close",
    "",
    "",
  ].join("\r\n"));

  const response = await new Promise((resolve, reject) => {
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
  });

  const headerEnd = response.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error(`Invalid HTTPS response from ${target.hostname}`);
  const headerText = response.subarray(0, headerEnd).toString("latin1");
  const headerLines = headerText.split("\r\n");
  const statusCode = Number(headerLines[0].split(" ")[1]);
  const headers = new Map(
    headerLines.slice(1).map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    }),
  );

  if (statusCode >= 300 && statusCode < 400 && headers.has("location")) {
    return download(new URL(headers.get("location"), target).href, redirectCount + 1);
  }
  if (statusCode !== 200) throw new Error(`Download failed with HTTP ${statusCode}: ${url}`);

  const body = response.subarray(headerEnd + 4);
  return headers.get("transfer-encoding")?.toLowerCase() === "chunked"
    ? decodeChunkedBody(body)
    : body;
}

for (const file of files) {
  const data = await download(file.source);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`SHA-256 mismatch for ${file.name}: expected ${file.sha256}, received ${sha256}`);
  }
  const outputDirectory = path.join(ROOT_DIR, file.directory);
  await mkdir(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, file.name);
  await writeFile(destination, data);
  console.log(`${file.name}\t${data.length} bytes\tsha256:${sha256}`);
}
