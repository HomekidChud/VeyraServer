#!/usr/bin/env node
"use strict";
const crypto = require("crypto");
const authSecret = crypto.randomBytes(32).toString("base64url");
const signupKey = crypto.randomBytes(32).toString("base64url");
console.log("Copy these two lines into the same Termux shell before starting Veyra:");
console.log(`export VEYRA_AUTH_SECRET='${authSecret}'`);
console.log(`export VEYRA_SIGNUP_KEY='${signupKey}'`);
console.log("Keep both values private. They are intentionally not saved to disk or printed by the server.");
