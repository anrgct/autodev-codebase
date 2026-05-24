import { getLlama, LlamaLogLevel } from 'node-llama-cpp';
async function main() {
  const llama = await getLlama({ logLevel: LlamaLogLevel.warn });
  const model = await llama.loadModel({ modelPath: '/Users/anrgct/llm_models/openbmb/MiniCPM-V-4.6-gguf/MiniCPM-V-4_6-Q8_0.gguf' });
  const fi = model.fileInsights;
  console.log('totalLayers:', fi.totalLayers);
  console.log('layerKeys:', Object.keys(fi).filter(k => k.toLowerCase().includes('layer') || k.toLowerCase().includes('block')));
  const raw = (model as any)._model?.metadata;
  if (raw) for (const k of Object.keys(raw)) if (k.includes('block')||k.includes('layer')||k.includes('count')) console.log(k,'=',raw[k]);
  await model.dispose();
}
main();
