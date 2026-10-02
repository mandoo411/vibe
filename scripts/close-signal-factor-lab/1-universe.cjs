const BT=process.env.BT_DIR||"/tmp/claude-0/bt";
// 후보군 전체 + 요인 계산 → univ2.json
const c=require(BT+"/candles.json");const fl=require(BT+"/flows.json");const list=require("../../assets/stock-list.json");const meta=new Map(list.map(s=>[s.code,s]));
const cache=require("../../data/kr-screener-cache.json");const sh=new Map();for(const r of cache.stocks||[])if(r.marketCapEok&&r.close)sh.set(r.code,r.marketCapEok*1e8/r.close);
const kospi=require(BT+"/idx_KOSPI.json");const kchg={};kospi.forEach((r,i)=>{if(i)kchg[r.localDate]=(r.closePrice/kospi[i-1].closePrice-1)*100});
const by={};
for(const [code,rows] of Object.entries(c)){const m=meta.get(code);if(!rows||!m||!(m.market==="KOSPI"||m.market==="KOSDAQ"))continue;if(/스팩|\d*우[BC]?$/.test(m.name))continue;
 const F=new Map((fl[code]||[]).map(r=>[r[0],r]));const dates=rows.map(r=>r[0]);
 for(let i=60;i<rows.length-1;i++){const r=rows[i];const d=r[0];if(d<"20240603"||d>"20261001")continue;const p=rows[i-1],n=rows[i+1];if(!(r[4]>0&&p[4]>0&&n[1]>0&&r[3]>0&&r[1]>0))continue;
  const tv=r[5]*(r[1]+r[2]+r[3]+r[4])/4/1e8;const chg=(r[4]/p[4]-1)*100;const s=sh.get(code);const mc=s?s*r[4]/1e8:null;
  const sl=(a,b)=>rows.slice(a,b);const v20=sl(i-20,i).reduce((q,x)=>q+x[5],0)/20;const hi60=Math.max(...sl(i-60,i).map(x=>x[2]));
  const ma20=sl(i-19,i+1).reduce((q,x)=>q+x[4],0)/20,ma60=sl(i-59,i+1).reduce((q,x)=>q+x[4],0)/60;
  let up=0;for(let k=i-1;k>0&&up<10;k--){if(rows[k][4]>rows[k-1][4])up++;else break;}
  // 수급: D-1 확정분(15:20 기준 알 수 있는 값)
  const fp=F.get(p[0]);const fS=(j)=>{let n=0;for(let k=i-1;k>=0&&n<20;k--){const x=F.get(dates[k]);if(!x||!(x[j]>0))break;n++;}return n};
  (by[d]??=[]).push({d,code,mk:m.market==="KOSDAQ"?1:0,tv,chg,mc,
   o:(n[1]/r[4]-1)*100,cl:(n[4]/r[4]-1)*100,
   gap:(r[1]/p[4]-1)*100,body:(r[4]/r[1]-1)*100,pos:(r[4]-r[3])/((r[2]-r[3])||1),upper:(r[2]/r[4]-1)*100,range:(r[2]-r[3])/p[4]*100,
   vr:v20?r[5]/v20:null,hi:(r[4]/hi60-1)*100,r5:(p[4]/rows[i-5][4]-1)*100,r20:(p[4]/rows[i-20][4]-1)*100,ma20:(r[4]/ma20-1)*100,ma60:(r[4]/ma60-1)*100,up,
   turn:mc?tv/mc*100:null,lmc:mc?Math.log10(mc):null,ltv:Math.log10(tv),
   fr:fp&&mc&&fp[1]!=null?fp[1]*p[4]/1e8/mc*100:null,ir:fp&&mc&&fp[2]!=null?fp[2]*p[4]/1e8/mc*100:null,fs:fS(1),is:fS(2),kd:kchg[d]});}}
const out=[];for(const d in by){by[d].sort((a,b)=>b.tv-a.tv);for(const x of by[d].slice(0,400))if(x.chg>=2&&x.chg<=20&&x.mc&&x.mc>=500&&x.mc<=200000)out.push(x);}
require("fs").writeFileSync(BT+"/univ2.json",JSON.stringify(out));console.log(out.length);
