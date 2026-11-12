import fs from "fs";

let _proxies = [];
let _idx = 0;

export function loadProxies(file) {
  if (!fs.existsSync(file)) return;
  _proxies = fs.readFileSync(file, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      l = l.replace(/^https?:\/\//, "");
      if (l.includes("@")) {
        const [auth, host] = l.split("@");
        return `http://${auth}@${host}`;
      }
      const parts = l.split(":");
      if (parts.length === 4) {
        const [ip, port, user, pass] = parts;
        return `http://${user}:${pass}@${ip}:${port}`;
      }
      return `http://${l}`;
    });
}

export function getProxyCount() {
  return _proxies.length;
}

export function getNextProxy() {
  if (_proxies.length === 0) return null;
  const proxy = _proxies[_idx % _proxies.length];
  _idx++;
  return proxy;
}