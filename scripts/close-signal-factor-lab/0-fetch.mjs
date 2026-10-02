import fs from "node:fs";
const DIR="/tmp/claude-0/bt";
const list=JSON.parse(fs.readFileSync(new URL("../../assets/stock-list.json", import.meta.url),"utf8")).filter(s=>s.market==="KOSPI"||s.market==="KOSDAQ");
const mode=process.argv[2];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(u,tries=4){for(let i=0;i<tries;i++){try{const r=await fetch(u);if(r.ok)return await r.text();}catch(e){}await sleep(500*(i+1));}return null;}
async function pool(items,n,fn){let i=0,done=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const it=items[i++];await fn(it);if(++done%200===0)console.log(mode,done,"/",items.length);}}));}
const parseSise=t=>{if(!t)return null;try{return JSON.parse(t.replace(/'/g,'"')).slice(1).map(r=>[String(r[0]).trim(),r[1],r[2],r[3],r[4],r[5]]);}catch{return null}};
if(mode==="idx"){
 for(const k of ["KOSPI","KOSDAQ"]){const rows=parseSise(await get(`https://api.finance.naver.com/siseJson.naver?symbol=${k}&requestType=1&startTime=20230101&endTime=20261002&timeframe=day`));
  fs.writeFileSync(`${DIR}/idx_${k}.json`,JSON.stringify(rows.map(r=>({localDate:r[0],openPrice:r[1],closePrice:r[4]}))));console.log(k,rows.length,rows.at(-1));}
}
if(mode==="candles"){
 const out={};
 await pool(list,16,async s=>{out[s.code]=parseSise(await get(`https://api.finance.naver.com/siseJson.naver?symbol=${s.code}&requestType=1&startTime=20230101&endTime=20261002&timeframe=day`));});
 fs.writeFileSync(`${DIR}/candles.json`,JSON.stringify(out));console.log("candles",Object.values(out).filter(Boolean).length);
}
if(mode==="flows"){
 const codes=JSON.parse(fs.readFileSync(`${DIR}/flowcodes.json`,"utf8"));
 const num=x=>x==null?null:Number(String(x).replace(/[,+]/g,""));
 const out={};
 await pool(codes,16,async code=>{const rows=[];let biz=null;
  for(let p=0;p<14;p++){const t=await get(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=60${biz?`&bizdate=${biz}`:""}`);if(!t)break;let a;try{a=JSON.parse(t)}catch{break}
   if(!a.length)break;for(const r of a)rows.push([r.bizdate,num(r.foreignerPureBuyQuant),num(r.organPureBuyQuant)]);
   const last=a.at(-1).bizdate;if(last<"20240415"||a.length<60)break;biz=last;}
  // dedupe
  const m=new Map(rows.map(r=>[r[0],r]));out[code]=[...m.values()];});
 fs.writeFileSync(`${DIR}/flows.json`,JSON.stringify(out));console.log("flows",Object.keys(out).length);
}
