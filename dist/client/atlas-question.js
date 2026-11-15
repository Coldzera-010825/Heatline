const topic = /\b(?:heatline|atlas|platform|workspace|data|census|review|priority|utci|lst|ndvi|ndwi|mndwi|era5|solweig|shade|geotiff|geojson|csv|study areas?|administrative areas?|boroughs?|boundar(?:y|ies)|walking heat|heat exposure)\b|平台|网站|工作区|研究空间|数据|人口|普查|优先级|核查|遮[荫阴]|地表温度|热暴露|研究区|边界|行政区|区划/;
const references = [
  /\b(?:data sources?|where (?:does|do|is|are).*(?:from|come))\b|来源|数据源|哪来的|从哪里|来自哪里/,
  /\b(?:definitions?|formula|how (?:is|are|was|were).*(?:calculated|estimated|modelled|modeled))\b|含义|定义|公式|如何计算|怎么算/,
  /\b(?:how (?:do|to|can).*(?:upload|import|export|download)|(?:what|which) (?:types of )?files?|file formats?|formats? (?:can|does|are))\b|怎么(?:导入|导出|上传|下载)|文件格式|支持.*(?:格式|文件)|(?:导入|上传|导出).*(?:什么|哪些|格式|限制)/,
  /\b(?:retention|expiry|expire|how long.*(?:kept|stored|last))\b|保留|保存多久|有效期|过期/,
];
const definition = /\b(?:what (?:is|are|does)|mean(?:ing|s)?)\b|是什么|什么意思|指什么/;
const result = /\b(?:results?|forecasts?|tomorrow|today|highest|lowest|maximum|minimum|in (?:this|my|the selected|the drawn) (?:selection|area)|after (?:the|a) .*scenario)\b|结果|实测|明天|预报|最高|最低|选区|这块区域|这个区域/;

export function isPlatformQuestion(text) {
  const query = text.normalize("NFKC").toLowerCase();
  return topic.test(query) && (references.some(pattern => pattern.test(query)) || definition.test(query) && !result.test(query));
}
