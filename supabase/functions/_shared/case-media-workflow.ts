import type { SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";
import "../../../assets/js/case-media.js";

export type Group = Record<string, any>;
export type Asset = { bucket: string; path: string };
const media = (globalThis as unknown as { CaseMedia: {
  sides: (group: Group) => string[];
  validateDraft: (group: Group) => boolean;
  inspectMp4: (read: (start: number, end: number) => Promise<ArrayBuffer>, size: number) => Promise<Record<string, unknown>>;
} }).CaseMedia;
export const snapshotKeys = ["before_public_path", "after_public_path", "published_canvas_ratio", "published_split_direction", "published_layout_kind",
  ...["before", "after"].flatMap(side => [`published_${side}_media_type`, `${side}_poster_public_path`, `published_${side}_video_meta`])];
export const clearSnapshot = () => Object.fromEntries(snapshotKeys.map(key => [key, null]));
export const snapshot = (group: Group) => Object.fromEntries(snapshotKeys.map(key => [key, group[key] ?? null]));
export function publishedAssets(groups: Group[]): Asset[] {
  return groups.flatMap(group => ["before", "after"].flatMap(side => [
    {bucket: group[`published_${side}_media_type`] === "video" ? "case-video-published" : "case-published", path: group[`${side}_public_path`]},
    {bucket: "case-video-published", path: group[`${side}_poster_public_path`]}
  ])).filter(asset => asset.path);
}
export async function removeAssets(client: SupabaseClient, assets: Asset[]) {
  for (const bucket of new Set(assets.map(asset => asset.bucket))) {
    const paths = [...new Set(assets.filter(asset => asset.bucket === bucket).map(asset => asset.path))];
    const {error} = await client.storage.from(bucket).remove(paths);
    if (error) throw new Error(`媒體清理失敗：${error.message}`);
  }
}
async function fileInfo(client: SupabaseClient, caseId: string, bucket: string, path: string, mime: string, max: number) {
  const parts = path.split("/");
  if (parts.length !== 3 || parts[1] !== caseId || parts.some(part => !part || part === "." || part === "..")) throw new Error("素材不屬於此案例");
  const {data,error} = await client.storage.from(bucket).list(parts.slice(0,2).join("/"), {search:parts[2],limit:100});
  if(error) throw error;
  const object = data?.find(item => item.name === parts[2]);
  const size = Number(object?.metadata?.size);
  if(!object || object.metadata?.mimetype !== mime || !Number.isFinite(size) || size <= 0 || size > max) throw new Error("素材尚未上傳完成，或格式／大小不符");
  return size;
}
export async function validateAssets(client: SupabaseClient, caseId: string, groups: Group[]) {
  if(!groups.length) throw new Error("至少需要一組完整素材");
  for(const group of groups) {
    media.validateDraft(group);
    for(const side of media.sides(group)) {
      const path = group[`${side}_private_path`];
      if(group[`${side}_media_type`] !== "video") {
        await fileInfo(client,caseId,"case-drafts",path,"image/webp",5*1024*1024);
        continue;
      }
      const size = await fileInfo(client,caseId,"case-video-drafts",path,"video/mp4",50*1024*1024);
      await fileInfo(client,caseId,"case-video-drafts",group[`${side}_poster_private_path`],"image/webp",5*1024*1024);
      const {data,error} = await client.storage.from("case-video-drafts").createSignedUrl(path,120);
      if(error || !data) throw error || new Error("影片驗證連結產生失敗");
      const verified = await media.inspectMp4(async (start,end) => {
        const response = await fetch(data.signedUrl,{headers:{Range:`bytes=${start}-${end-1}`},signal:AbortSignal.timeout(15000)});
        if(response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${start}-${end-1}/${size}`) {
          await response.body?.cancel(); throw new Error("影片儲存服務未提供正確的分段讀取");
        }
        const bytes = await response.arrayBuffer();
        if(bytes.byteLength !== end-start) throw new Error("影片資料不完整");
        return bytes;
      },size);
      // Publish only metadata obtained from the object, not browser-provided values.
      group[`${side}_video_meta`] = verified;
    }
  }
}
export async function copyGroup(client: SupabaseClient, caseId: string, group: Group, copied: Asset[]) {
  const result: Group = {...clearSnapshot(), published_layout_kind:group.layout_kind || "comparison", published_canvas_ratio:group.canvas_ratio, published_split_direction:group.split_direction};
  for(const side of media.sides(group)) {
    const video=group[`${side}_media_type`] === "video";
    const sourceBucket=video?"case-video-drafts":"case-drafts", bucket=video?"case-video-published":"case-published";
    const path=`${caseId}/${group.id}-${side}-${crypto.randomUUID()}.${video?"mp4":"webp"}`;
    const copy=await client.storage.from(sourceBucket).copy(group[`${side}_private_path`],path,{destinationBucket:bucket});
    if(copy.error) throw copy.error;
    copied.push({bucket,path});
    result[`${side}_public_path`]=path;
    result[`published_${side}_media_type`]=video?"video":"image";
    if(video) {
      const poster=`${caseId}/${group.id}-${side}-${crypto.randomUUID()}-poster.webp`;
      const copyPoster=await client.storage.from("case-video-drafts").copy(group[`${side}_poster_private_path`],poster,{destinationBucket:bucket});
      if(copyPoster.error)throw copyPoster.error;
      copied.push({bucket,path:poster});result[`${side}_poster_public_path`]=poster;
      result[`published_${side}_video_meta`]=group[`${side}_video_meta`];
    }
  }
  return result;
}
