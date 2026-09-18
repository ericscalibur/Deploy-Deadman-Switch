#!/usr/bin/env node
// Minimal SMTP sink for local end-to-end runs. Accepts anything (EHLO, AUTH
// PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT), never relays, writes each message to
// a directory as NNNN.eml with an "X-Sink-Envelope-To" header prepended.
//
//   node tests/tools/smtp-sink.js [port] [dir]
//   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USER=x SMTP_PASS=y  (EMAIL_USER unset)
const net = require("net");
const fs = require("fs");
const path = require("path");

const port = parseInt(process.argv[2], 10) || 2525;
const dir = process.argv[3] || path.join(require("os").tmpdir(), "deploy-smtp-sink");
fs.mkdirSync(dir, { recursive: true });
let counter = fs.readdirSync(dir).filter((f) => f.endsWith(".eml")).length;

const server = net.createServer((socket) => {
  let buffer = "";
  let inData = false;
  let rcpts = [];
  let from = "";
  const send = (line) => socket.write(line + "\r\n");
  send("220 sink ESMTP");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        const raw = buffer.slice(0, end).replace(/\r\n\.\./g, "\r\n.");
        buffer = buffer.slice(end + 5);
        inData = false;
        counter += 1;
        const name = String(counter).padStart(4, "0") + ".eml";
        const head = `X-Sink-Envelope-To: ${rcpts.join(", ")}\r\nX-Sink-Envelope-From: ${from}\r\nX-Sink-Received: ${new Date().toISOString()}\r\n`;
        fs.writeFileSync(path.join(dir, name), head + raw + "\r\n");
        console.log(`[sink] ${name} to ${rcpts.join(", ")}`);
        rcpts = [];
        send("250 OK queued");
        continue;
      }
      const nl = buffer.indexOf("\r\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") {
        send("250-sink");
        send("250-AUTH PLAIN LOGIN");
        send("250-8BITMIME");
        send("250 SIZE 10485760");
      } else if (cmd === "AUTH") {
        if (/^AUTH LOGIN$/i.test(line)) {
          send("334 VXNlcm5hbWU6");
          socket.once("data", () => {
            send("334 UGFzc3dvcmQ6");
            socket.once("data", () => send("235 OK"));
          });
        } else {
          send("235 OK");
        }
      } else if (cmd === "MAIL") {
        from = (line.match(/<([^>]*)>/) || [])[1] || "";
        send("250 OK");
      } else if (cmd === "RCPT") {
        rcpts.push((line.match(/<([^>]*)>/) || [])[1] || "");
        send("250 OK");
      } else if (cmd === "DATA") {
        inData = true;
        send("354 End data with <CR><LF>.<CR><LF>");
      } else if (cmd === "QUIT") {
        send("221 Bye");
        socket.end();
      } else if (cmd === "RSET" || cmd === "NOOP") {
        send("250 OK");
      } else if (cmd === "STARTTLS") {
        send("454 TLS not available");
      } else {
        send("250 OK");
      }
    }
  });
  socket.on("error", () => {});
});
server.listen(port, "127.0.0.1", () => {
  console.log(`[sink] SMTP sink listening on 127.0.0.1:${port}, writing to ${dir}`);
});
