import type { Config, VoicePrices } from './types.js';
export type PriceGroup='low'|'high'|'advanced';
const parts=['textInput','audioInput','textOutput','audioOutput'] as const;
type Part=typeof parts[number];
export interface BillingRow {
  group:PriceGroup;model:string;calls:number;inputTokens:number;outputTokens:number;
  tokens:Record<Part,number>;cost:number;unpricedTokens:number;unclassifiedTokens:number;unallocatedTokens:number;missingUsageReports:number;
}
export interface BillingSnapshot {rows:BillingRow[];knownCost:number;incomplete:boolean;totalTokens:number;note:string;}
const number=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export class BillingMeter {
  private rows=new Map<string,BillingRow>();
  reset(){this.rows.clear();}
  record(event:{role:string;model?:string;priceGroup?:PriceGroup;usage:any},config:Config){
    const group:PriceGroup=event.priceGroup||(event.role==='advanced'?'advanced':event.role==='high'?'high':'low');
    const model=event.model||config[group==='advanced'?'advanced':group].model;
    const key=JSON.stringify([group,model]);
    let row=this.rows.get(key);
    if(!row){row={group,model,calls:0,inputTokens:0,outputTokens:0,tokens:{textInput:0,audioInput:0,textOutput:0,audioOutput:0},cost:0,unpricedTokens:0,unclassifiedTokens:0,unallocatedTokens:0,missingUsageReports:0};this.rows.set(key,row);}
    row.calls++;
    const usage=event.usage||{},input=usage.input_tokens??usage.prompt_tokens,output=usage.output_tokens??usage.completion_tokens;
    const rates:VoicePrices=group==='low'?config.prices:group==='high'?config.highPrices:{textInput:config.advancedPrices.input,textOutput:config.advancedPrices.output,audioInput:null,audioOutput:null};
    const classifiedBefore=Object.values(row.tokens).reduce((n,v)=>n+v,0);
    for(const [direction,total,detail] of [['Input',input,usage.input_tokens_details||usage.input_token_details],['Output',output,usage.output_tokens_details||usage.output_token_details]] as const){
      const known:Partial<Record<Part,number>>={};
      if(group==='advanced'){
        if(number(total))known[('text'+direction) as Part]=total;
      }else{
        if(number(detail?.text_tokens))known[('text'+direction) as Part]=detail.text_tokens;
        if(number(detail?.audio_tokens))known[('audio'+direction) as Part]=detail.audio_tokens;
      }
      const sum=Object.values(known).reduce((n,v)=>n+(v||0),0);
      // A contradictory breakdown is not safe to price.
      if(number(total)&&sum>total){row.unclassifiedTokens+=total;row[direction==='Input'?'inputTokens':'outputTokens']+=total;continue;}
      row[direction==='Input'?'inputTokens':'outputTokens']+=number(total)?total:sum;
      if(number(total))row.unclassifiedTokens+=Math.max(0,total-sum);
      else if(!Object.keys(known).length)row.missingUsageReports++;
      for(const part of parts){const count=known[part]||0;row.tokens[part]+=count;if(number(rates[part]))row.cost+=count*rates[part]!/1e6;else row.unpricedTokens+=count;}
    }
    // Some providers report only a total, without input/output separation.
    if(!number(input)&&!number(output)&&number(usage.total_tokens)&&Object.values(row.tokens).reduce((n,v)=>n+v,0)===classifiedBefore){row.unclassifiedTokens+=usage.total_tokens;row.unallocatedTokens+=usage.total_tokens;}
  }
  snapshot():BillingSnapshot{
    const rows=structuredClone([...this.rows.values()]);
    return {rows,knownCost:rows.reduce((n,r)=>n+r.cost,0),incomplete:rows.some(r=>r.unpricedTokens>0||r.unclassifiedTokens>0||r.missingUsageReports>0),
      totalTokens:rows.reduce((n,r)=>n+r.inputTokens+r.outputTokens+r.unallocatedTokens,0),note:'元，按各模型普通单价粗估；只统计已报告用量，不含缓存折扣、搜索、独立转写、连接测试或尚未报告的计费。未计价不等于免费。'};
  }
}
