// 비용 반영 분석(2026-10-02): crash-backtest.mjs를 BT_TOPN=10 BT_OUT=daily10.json으로 돌린 뒤 BT_DIR에서 실행. 순위·점수·합의·등락률·시총별 익일 시가 수익과 비용(0.23%) 차감값.
const d=require((process.env.BT_DIR||"/tmp/claude-0/bt")+"/daily10.json").filter(x=>x.next);
const COST=0.23;
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
const f=v=>isNaN(v)?"  -  ":(v>=0?"+":"")+v.toFixed(2);
const picks=[];for(const x of d)x.close.forEach((p,i)=>{if(p.openRet!=null)picks.push({...p,rank:i+1,date:x.date,yr:x.date<"2025-01-01"?"24H2":x.date<"2026-01-01"?"2025":"2026",crash:x.kospiNext<=-3,kospiDay:x.kospiDay});});
const row=(lab,ps)=>{const o=avg(ps.map(p=>p.openRet)),c=avg(ps.map(p=>p.closeRet));const pos=ps.filter(p=>p.openRet>COST).length/ps.length*100;
 const by=y=>avg(ps.filter(p=>p.yr===y).map(p=>p.openRet)-0);
 console.log(lab.padEnd(26),String(ps.length).padStart(5),"open",f(o),"net",f(o-COST),"close",f(c),"win>cost",pos.toFixed(0)+"%"," | 24H2",f(avg(ps.filter(p=>p.yr==="24H2").map(p=>p.openRet))),"25",f(avg(ps.filter(p=>p.yr==="2025").map(p=>p.openRet))),"26",f(avg(ps.filter(p=>p.yr==="2026").map(p=>p.openRet))));};
console.log("== 순위별");for(let r=1;r<=10;r++)row("rank "+r,picks.filter(p=>p.rank===r));
console.log("== 상위 N (종목 단위 평균)");for(const n of [1,2,3,5,10])row("top"+n,picks.filter(p=>p.rank<=n));
console.log("== 점수 (상위10 중)");for(const [a,b] of [[0,50],[50,55],[55,60],[60,65],[65,70],[70,75],[75,101]])row(`score ${a}-${b}`,picks.filter(p=>p.score>=a&&p.score<b));
console.log("== 합의 수");for(const c of [0,1,2,3,4,5])row("consensus "+c+(c==5?"+":""),picks.filter(p=>c==5?p.consensus>=5:p.consensus===c));
console.log("== 당일 등락률");for(const [a,b] of [[0,3],[3,5],[5,7],[7,10],[10,15],[15,31]])row(`chg ${a}-${b}`,picks.filter(p=>p.chg>=a&&p.chg<b));
console.log("== 시총(억)");for(const [a,b] of [[0,1000],[1000,3000],[3000,10000],[10000,50000],[50000,1e9]])row(`mc ${a}-${b}`,picks.filter(p=>p.mc>=a&&p.mc<b));
console.log("== 거래대금(억)");for(const [a,b] of [[0,100],[100,300],[300,1000],[1000,3000],[3000,1e9]])row(`tv ${a}-${b}`,picks.filter(p=>p.tv>=a&&p.tv<b));
console.log("== 선정일 코스피");for(const [a,b] of [[-99,-1],[-1,0],[0,1],[1,99]])row(`kospiDay ${a}~${b}`,picks.filter(p=>p.kospiDay>=a&&p.kospiDay<b&&p.rank<=5));
