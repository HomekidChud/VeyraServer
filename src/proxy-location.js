"use strict";
const acorn = require("acorn");
const walk = require("acorn-walk");
const crypto = require("node:crypto");
const plans = new Map();
const SCOPE_TYPES = new Set(["Program", "BlockStatement", "FunctionDeclaration", "FunctionExpression",
  "ArrowFunctionExpression", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement",
  "SwitchStatement", "ClassDeclaration", "ClassExpression"]);
const FUNCTION_TYPES = new Set(["Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function bind(pattern, scope) {
  if (!pattern || !scope) return;
  if (pattern.type === "Identifier") scope.names.add(pattern.name);
  else if (pattern.type === "RestElement") bind(pattern.argument, scope);
  else if (pattern.type === "AssignmentPattern") bind(pattern.left, scope);
  else if (pattern.type === "ArrayPattern") for (const item of pattern.elements) bind(item, scope);
  else if (pattern.type === "ObjectPattern") for (const item of pattern.properties)
    bind(item.type === "RestElement" ? item.argument : item.value, scope);
}
function propertyName(node) {
  return node.computed ? node.property.type === "Literal" ? node.property.value : null : node.property.name;
}
function isWrite(node, parent, ancestors) {
  if (!parent) return false;
  if ((parent.type === "AssignmentExpression" && parent.left === node) ||
      (parent.type === "UpdateExpression" && parent.argument === node) ||
      (parent.type === "UnaryExpression" && parent.operator === "delete") ||
      ((parent.type === "ForInStatement" || parent.type === "ForOfStatement") && parent.left === node)) return true;
  return ancestors.some(a => a.type === "ObjectPattern" || a.type === "ArrayPattern");
}
function planSource(text) {
  if (!/\blocation\b|import\s*\.\s*meta/.test(text)) return [];
  let ast;
  const options = { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(text, { ...options, sourceType: "module" }); }
  catch {
    try { ast = acorn.parse(text, { ...options, sourceType: "script" }); }
    catch { return []; }
  }
  const scopes = new WeakMap();
  walk.full(ast, node => {
    if (SCOPE_TYPES.has(node.type)) scopes.set(node, { names: new Set(), parent: null, function: FUNCTION_TYPES.has(node.type) });
  });
  const nearest = ancestors => {
    for (let i = ancestors.length - 1; i >= 0; i--) if (scopes.has(ancestors[i])) return scopes.get(ancestors[i]);
    return null;
  };
  walk.fullAncestor(ast, (node, _, ancestors) => {
    const own = scopes.get(node);
    if (own) own.parent = nearest(ancestors.slice(0, -1));
    const scope = nearest(ancestors);
    if (node.type === "VariableDeclaration") {
      let destination = scope;
      if (node.kind === "var") while (destination && !destination.function) destination = destination.parent;
      // Parent links for enclosing scopes are populated postorder below.
      if (node.kind === "var") destination = nearest(ancestors.filter(a => FUNCTION_TYPES.has(a.type)));
      for (const decl of node.declarations) bind(decl.id, destination);
    } else if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      for (const param of node.params) bind(param, own);
      if (node.id) bind(node.id, node.type === "FunctionDeclaration" ? nearest(ancestors.slice(0, -1)) : own);
    } else if (node.type === "CatchClause") bind(node.param, own);
    else if (node.type === "ClassDeclaration") bind(node.id, nearest(ancestors.slice(0, -1)));
    else if (node.type === "ClassExpression") bind(node.id, own);
    else if (node.type === "ImportDeclaration") for (const item of node.specifiers) bind(item.local, scope);
  });
  const bound = (name, scope) => {
    while (scope) { if (scope.names.has(name)) return true; scope = scope.parent; }
    return false;
  };
  const edits = [];
  walk.fullAncestor(ast, (node, _, ancestors) => {
    const parent = ancestors[ancestors.length - 2];
    if (node.type === "MemberExpression") {
      if (isWrite(node, parent, ancestors) ||
          (parent?.type === "CallExpression" && parent.callee === node) ||
          (parent?.type === "NewExpression" && parent.callee === node) ||
          (parent?.type === "TaggedTemplateExpression" && parent.tag === node)) return;
      const key = propertyName(node);
      if (key === "location") {
        edits.push({ start: node.start, end: node.end, kind: "member", objectStart: node.object.start,
          objectEnd: node.object.end, optional: !!node.optional });
      } else if (key === "url" && node.object.type === "MetaProperty" &&
          node.object.meta.name === "import" && node.object.property.name === "meta") {
        edits.push({ start: node.start, end: node.end, kind: "meta" });
      }
    } else if (node.type === "Identifier" && node.name === "location") {
      if (bound("location", nearest(ancestors)) || isWrite(node, parent, ancestors)) return;
      if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      if (parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return;
      if (["LabeledStatement", "BreakStatement", "ContinueStatement", "ImportSpecifier", "ExportSpecifier"].includes(parent?.type)) return;
      edits.push({ start: node.start, end: node.end, kind: parent?.type === "Property" && parent.shorthand ? "shorthand" : "identifier" });
    }
  });
  return edits.sort((a, b) => a.start - b.start || b.end - a.end);
}
function sourcePlan(text) {
  const key = crypto.createHash("sha256").update(text).digest("hex");
  if (plans.has(key)) { const plan = plans.get(key); plans.delete(key); plans.set(key, plan); return plan; }
  const plan = planSource(text);
  plans.set(key, plan);
  if (plans.size > 64) plans.delete(plans.keys().next().value);
  return plan;
}
function rewriteLocationReads(source, canonical) {
  const text = String(source || "");
  const edits = sourcePlan(text);
  if (!edits.length) return text;
  const memberHelper = "(globalThis.__VEYRA_GET_LOCATION__||((o,p)=>p&&o==null?void 0:o.location))";
  const identifier = "(globalThis.__VEYRA_LOCATION__||location)";
  function range(start, end) {
    const pieces = [];
    let cursor = start;
    for (const edit of edits) {
      if (edit.start < cursor || edit.end > end) continue;
      pieces.push(text.slice(cursor, edit.start));
      if (edit.kind === "member") pieces.push(`${memberHelper}(${range(edit.objectStart, edit.objectEnd)}${edit.optional ? ",true" : ""})`);
      else if (edit.kind === "meta") pieces.push(JSON.stringify(canonical));
      else pieces.push(edit.kind === "shorthand" ? `location:${identifier}` : identifier);
      cursor = edit.end;
    }
    pieces.push(text.slice(cursor, end));
    return pieces.join("");
  }
  return range(0, text.length);
}
module.exports = { rewriteLocationReads };
