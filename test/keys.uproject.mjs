import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
const keys = new Map(); const moduleKeys = new Map(); const refKeys = new Map();
let count = 0; const failed = [];
function bump(m,k){m.set(k,(m.get(k)??0)+1);}
function walk(dir, depth=0){ if(depth>4) return; let es; try{es=readdirSync(dir);}catch{return;}
 for(const e of es){ const p=join(dir,e); let st; try{st=statSync(p);}catch{continue;}
  if(st.isDirectory()){ if(!["Binaries","Intermediate","Saved","ThirdParty",".git","Build"].includes(e)) walk(p,depth+1); continue;}
  if(!e.endsWith(".uproject")) continue; count++;
  const errors=[]; const res=parse(readFileSync(p,"utf8").replace(/^\uFEFF/,""),errors,{allowTrailingComma:true,disallowComments:false});
  if(errors.length) failed.push(`${p} :: ${errors.map(x=>x.error).join(",")}`);
  if(!res||typeof res!=="object") continue;
  for(const k of Object.keys(res)) bump(keys,k);
  for(const m of Array.isArray(res.Modules)?res.Modules:[]) if(m&&typeof m==="object") for(const k of Object.keys(m)) bump(moduleKeys,k);
  for(const r of Array.isArray(res.Plugins)?res.Plugins:[]) if(r&&typeof r==="object") for(const k of Object.keys(r)) bump(refKeys,k);
 }
}
for(const root of process.argv.slice(2)) walk(root);
const fmt=(m)=>[...m.entries()].sort((a,b)=>b[1]-a[1]).map(([k,c])=>`${k}(${c})`).join(" ");
console.log(`uproject files: ${count} with parse errors: ${failed.length}`);
for(const l of failed.slice(0,8)) console.log(" FAIL",l);
console.log("\nUPROJECT KEYS:",fmt(keys));
console.log("\nUPROJECT MODULE KEYS:",fmt(moduleKeys));
console.log("\nUPROJECT PLUGIN-REF KEYS:",fmt(refKeys));
