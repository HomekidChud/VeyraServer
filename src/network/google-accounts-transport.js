"use strict";

const https = require("node:https");
const { Readable } = require("node:stream");

function isGoogleAccountsUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    return url.protocol === "https:" && url.hostname.toLowerCase() === "accounts.google.com";
  } catch {
    return false;
  }
}

function toNodeHeaders(source) {
  const out = {};
  if (source && typeof source.forEach === "function") {
    source.forEach((value, name) => {
      if (String(name).toLowerCase() !== "accept-encoding") out[name] = String(value);
    });
  } else {
    for (const [name, value] of Object.entries(source || {})) {
      if (String(name).toLowerCase() !== "accept-encoding" && value != null) out[name] = value;
    }
  }
  // Google's Accounts edge returns a normal sign-in response to the native
  // HTTPS request but rejects the equivalent Undici request. Requesting an
  // uncompressed body keeps this adapter compatible with Veyra's body reader.
  out["accept-encoding"] = "identity";
  return out;
}

function toWebHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(rawHeaders || {})) {
    if (rawValue == null) continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      headers.append(name, String(value));
    }
  }
  return headers;
}

function requestGoogleAccounts(rawUrl, options = {}) {
  if (!isGoogleAccountsUrl(rawUrl)) {
    return Promise.reject(new TypeError("Native Google Accounts transport only accepts https://accounts.google.com URLs."));
  }
  const url = new URL(String(rawUrl));
  const requestImpl = options.requestImpl || https.request;
  const method = String(options.method || "GET").toUpperCase();
  const headers = toNodeHeaders(options.headers);
  const requestOptions = {
    method,
    headers,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestImpl(url, requestOptions, response => {
      settled = true;
      const status = Number(response.statusCode) || 0;
      const responseHeaders = toWebHeaders(response.headers);
      const redirect = status >= 300 && status < 400 && responseHeaders.has("location");
      const bodyless = method === "HEAD" || status === 204 || status === 304 || redirect;
      if (bodyless) {
        response.resume();
        resolve({ ok: status >= 200 && status < 300, status, statusText: response.statusMessage || "", headers: responseHeaders, body: null });
        return;
      }
      resolve({ ok: status >= 200 && status < 300, status, statusText: response.statusMessage || "", headers: responseHeaders, body: Readable.toWeb(response) });
    });
    request.once("error", error => {
      if (!settled) reject(error);
    });
    try {
      if (options.body == null) request.end();
      else request.end(options.body);
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { isGoogleAccountsUrl, requestGoogleAccounts };
