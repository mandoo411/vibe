const BT=process.env.BT_DIR||"/tmp/claude-0/bt";
const U=require(BT+"/univ2.json");const FEAT=["chg","gap","body","pos","upper","range","vr","hi","r5","r20","ma20","ma60","up","turn","lmc","ltv","mk","fr","ir","fs","is"];
const days={};for(const x of U)(days[x.d]??=[]).push(x);
const rank=a=>{const idx=a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const r=new Array(a.length);idx.forEach(([v,i],k)=>r[i]=k);return r};
const corr=(a,b)=>{const n=a.length,ma=a.reduce((s,x)=>s+x,0)/n,mb=b.reduce((s,x)=>s+x,0)/n;let sab=0,saa=0,sbb=0;for(let i=0;i<n;i++){sab+=(a[i]-ma)*(b[i]-mb);saa+=(a[i]-ma)**2;sbb+=(b[i]-mb)**2}return sab/Math.sqrt(saa*sbb)};
const res={};
for(const f of FEAT){const tr=[],te=[];const qs={tr:[[],[],[],[],[]],te:[[],[],[],[],[]]};
 for(const d in days){const xs=days[d].filter(x=>x[f]!=null&&isFinite(x[f]));if(xs.length<30)continue;const ic=corr(rank(xs.map(x=>x[f])),rank(xs.map(x=>x.o)));if(isNaN(ic))continue;
  const per=d<"20260101"?"tr":"te";(per==="tr"?tr:te).push(ic);
  const s=[...xs].sort((a,b)=>a[f]-b[f]);s.forEach((x,k)=>qs[per][Math.min(4,Math.floor(k/s.length*5))].push(x.o));}
 const st=a=>{const m=a.reduce((s,x)=>s+x,0)/a.length;const sd=Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/a.length);return [m,m/sd*Math.sqrt(a.length)]};
 const [mt,tt]=st(tr),[me,te2]=st(te);const q=p=>qs[p].map(a=>(a.reduce((s,x)=>s+x,0)/a.length).toFixed(2)).join(" ");
 console.log(f.padEnd(6),"IC train",(mt*100).toFixed(1).padStart(5),"t",tt.toFixed(1).padStart(5)," test",(me*100).toFixed(1).padStart(5),"t",te2.toFixed(1).padStart(5)," | Q1..Q5 train",q("tr")," test",q("te"));}
