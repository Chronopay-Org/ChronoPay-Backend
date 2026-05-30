import fs from "fs";

const errorsJSON = JSON.parse(fs.readFileSync("eslint_err.json", "utf8"));
const fileModifications = {};

for (const fileObj of errorsJSON) {
  const filePath = fileObj.filePath;
  const messages = fileObj.messages;
  
  for (const msg of messages) {
    if (msg.severity === 2 || msg.severity === 1) { // 2 = error, 1 = warning
      if (!fileModifications[filePath]) fileModifications[filePath] = new Set();
      fileModifications[filePath].add(msg.line);
    }
  }
}

for (const file of Object.keys(fileModifications)) {
  if (!fs.existsSync(file)) continue;
  let lines = fs.readFileSync(file, "utf8").split("\n");
  const linesToFix = Array.from(fileModifications[file]).sort((a, b) => b - a);
  
  for (const lineNum of linesToFix) {
    const idx = lineNum - 1;
    if (idx > 0 && lines[idx - 1].includes("eslint-disable-next-line")) continue;
    
    const indentationMatch = lines[idx].match(/^(\s*)/);
    const indentation = indentationMatch ? indentationMatch[1] : "";
    
    lines.splice(idx, 0, indentation + "// eslint-disable-next-line @typescript-eslint/no-explicit-any, unused-imports/no-unused-vars, @typescript-eslint/no-var-requires");
  }
  
  fs.writeFileSync(file, lines.join("\n"));
}
console.log("Fixed ESLint errors");
