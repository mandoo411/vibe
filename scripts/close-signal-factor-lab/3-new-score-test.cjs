const BT=process.env.BT_DIR||"/tmp/claude-0/bt";
const U=require(BT+"/univ2.json");const D10=require(BT+"/daily10.json");
const days={};for(const x of U)(days[x.d]??=[]).push(x);
const COST=0.23;const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;const f=v=>(v>=0?"+":"")+v.toFixed(2);
const per=d=>d<"20250101"?0:d<"20260101"?1:2;
function pctRank(xs,k){const v=xs.map(x=>x[k]);const s=[...v].filter(z=>z!=null).sort((a,b)=>a-b);return v.map(z=>z==null?0.5:(s.indexOf(z))/(s.length-1||1));}
function run(name,feats,N=5,dayFilter=null){const res=[[],[],[]],all=[];const dayRets=[[],[],[]];
 for(const d in days){if(dayFilter&&!dayFilter(days[d]))continue;const xs=days[d];if(xs.length<10)continue;const sc=new Array(xs.length).fill(0);
  for(const [k,sgn] of feats){const r=pctRank(xs,k);r.forEach((v,i)=>sc[i]+=sgn>0?v:1-v);}
  const pick=xs.map((x,i)=>[sc[i],x]).sort((a,b)=>b[0]-a[0]).slice(0,N).map(p=>p[1]);
  const dr=avg(pick.map(p=>p.o));dayRets[per(d)].push(dr);pick.forEach(p=>{res[per(d)].push(p.o);all.push(p)});}
 const yrs=res.map(a=>f(avg(a)));const dall=[].concat(...dayRets);
 const pos=dall.filter(v=>v>COST).length/dall.length*100;
 console.log(name.padEnd(30),"전체",f(avg(all.map(p=>p.o))),"비용후",f(avg(all.map(p=>p.o))-COST)," |24H2",yrs[0],"25",yrs[1],"26(검증)",yrs[2],"→비용후",f(avg(res[2])-COST),"| 일수",dall.length,"비용넘은날",pos.toFixed(0)+"%","종가",f(avg(all.map(p=>p.cl))));}
// 비교군
{const r=[[],[],[]];for(const x of U)r[per(x.d)].push(x.o);console.log("무작위(후보군 전체)".padEnd(30),"                         |24H2",f(avg(r[0])),"25",f(avg(r[1])),"26(검증)",f(avg(r[2])));}
{const r=[[],[],[]];for(const x of D10)if(x.next)x.close.slice(0,5).forEach(p=>{if(p.openRet!=null)r[per(x.date.replace(/-/g,""))].push(p.openRet)});console.log("현행 상위5".padEnd(30),"                         |24H2",f(avg(r[0])),"25",f(avg(r[1])),"26(검증)",f(avg(r[2])));}
const A=[["chg",-1],["body",-1],["range",-1],["vr",-1],["ma20",-1],["ma60",-1],["hi",-1],["r20",-1],["ltv",-1]];
run("A 9요인 동일가중",A);
run("B 핵심4(chg,body,ma20,ma60)",[["chg",-1],["body",-1],["ma20",-1],["ma60",-1]]);
run("C 이격만(ma20,ma60)",[["ma20",-1],["ma60",-1]]);
run("D 이격+거래대금(ma20,ma60,ltv)",[["ma20",-1],["ma60",-1],["ltv",-1]]);
run("A 상위3",A,3);run("A 상위10",A,10);
// A vs 무작위: 일별 차이 t값, 급락일 성과
{const A2=A;const diff=[[],[],[]];const crash=[];const k=require(BT+"/idx_KOSPI.json");const nx={};k.forEach((r,i)=>{if(i)nx[k[i-1].localDate]=(r.closePrice/k[i-1].closePrice-1)*100});
 for(const d in days){const xs=days[d];if(xs.length<10)continue;const sc=new Array(xs.length).fill(0);for(const [kk,s] of A2){pctRank(xs,kk).forEach((v,i)=>sc[i]+=s>0?v:1-v);}
  const pick=xs.map((x,i)=>[sc[i],x]).sort((a,b)=>b[0]-a[0]).slice(0,5).map(p=>p[1]);const pr=avg(pick.map(p=>p.o)),rr=avg(xs.map(x=>x.o));diff[per(d)].push(pr-rr);if(nx[d]<=-3)crash.push([pr,rr]);}
 for(let p=0;p<3;p++){const a=diff[p],m=avg(a),sd=Math.sqrt(avg(a.map(x=>(x-m)**2)));console.log("A-무작위 기간",p,"일평균차",f(m),"t",(m/sd*Math.sqrt(a.length)).toFixed(2),"n",a.length);}
 console.log("급락일",crash.length,"A",f(avg(crash.map(c=>c[0]))),"무작위",f(avg(crash.map(c=>c[1]))));}
