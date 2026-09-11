(function (root, factory) {
  const api = factory();
  root.CaseMedia = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  "use strict";
  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_SECONDS = 60;
  const sides = group => group.layoutKind === "single" || group.layout_kind === "single" ? ["before"] : ["before", "after"];
  const groups = item => item.mediaGroups || item.beforeAfterPairs || [];
  const complete = group => Boolean(group && sides(group).every(side => {
    const item = group[side];
    return item?.src && (item.type !== "video" || item.poster);
  }));
  function validateDraft(group) {
    if (group.layout_kind === "single" && group.after_private_path) throw new Error("單一素材不可保留術後素材");
    for (const side of sides(group)) {
      if (!group[`${side}_private_path`]) throw new Error("每組素材都必須完整，對照組需包含術前與術後");
      if (group[`${side}_media_type`] === "video") {
        const meta = group[`${side}_video_meta`];
        if (!group[`${side}_poster_private_path`] || !meta || !Number.isFinite(meta.duration) || meta.duration <= 0 || meta.duration > MAX_SECONDS || !Number.isFinite(meta.size) || meta.size <= 0 || meta.size > MAX_BYTES || meta.videoCodec !== "h264" || ![null, "aac"].includes(meta.audioCodec)) {
          throw new Error("影片需有封面，且為 60 秒／50MB 內的 H.264 MP4（AAC 或無音訊）");
        }
      }
    }
    return true;
  }

  // Parse only MP4 headers / moov, never the large mdat payload. Shared by the
  // browser (Blob.slice) and publication validation (bounded HTTP Range reads).
  const tag = (bytes, at) => String.fromCharCode(...bytes.slice(at, at + 4));
  const uint = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at);
  function boxSize(bytes, at, remaining) {
    let size = uint(bytes, at), header = 8;
    if (size === 1) { size = uint(bytes, at + 8) * 4294967296 + uint(bytes, at + 12); header = 16; }
    if (size === 0) size = remaining;
    if (!Number.isSafeInteger(size) || size < header || size > remaining) throw new Error("MP4 結構損壞");
    return { size, header };
  }
  function children(bytes, start = 0, end = bytes.length) {
    const result = [];
    for (let at = start; at < end;) {
      if (end - at < 8) throw new Error("MP4 結構不完整");
      const { size, header } = boxSize(bytes, at, end - at);
      result.push({ type: tag(bytes, at + 4), start: at + header, end: at + size });
      at += size;
    }
    return result;
  }
  function child(bytes, parent, name) {
    const value = children(bytes, parent.start, parent.end).find(box => box.type === name);
    if (!value) throw new Error(`MP4 缺少 ${name}`);
    return value;
  }
  async function inspectMp4(read, size) {
    if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw new Error("影片上限為 50MB");
    let moov = null, hasFtyp = false;
    for (let offset = 0, count = 0; offset < size; count++) {
      if (count > 10000) throw new Error("MP4 結構過於複雜");
      const head = new Uint8Array(await read(offset, Math.min(size, offset + 16)));
      if (head.length < 8) throw new Error("不是有效 MP4");
      const box = boxSize(head, 0, size - offset);
      const type = tag(head, 4);
      if (type === "ftyp") hasFtyp = true;
      if (type === "moov") {
        if (box.size > 4 * 1024 * 1024) throw new Error("影片索引過大，請重新匯出 MP4");
        moov = new Uint8Array(await read(offset + box.header, offset + box.size));
      }
      offset += box.size;
    }
    if (!hasFtyp || !moov) throw new Error("請上傳完整 MP4 影片");
    const root = { start: 0, end: moov.length };
    if (children(moov).some(box => box.type === "mvex")) throw new Error("請匯出一般 MP4，不支援分段串流檔案");
    const movie = child(moov, root, "mvhd");
    const time = movie.start + (moov[movie.start] === 1 ? 20 : 12);
    const scale = uint(moov, time);
    const ticks = moov[movie.start] === 1 ? uint(moov, time + 4) * 4294967296 + uint(moov, time + 8) : uint(moov, time + 4);
    const duration = ticks / scale;
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) throw new Error("影片需為 60 秒以內");
    let videoCodec = null, audioCodec = null, width = 0, height = 0;
    for (const track of children(moov).filter(box => box.type === "trak")) {
      const mdia = child(moov, track, "mdia");
      const handler = child(moov, mdia, "hdlr");
      const kind = tag(moov, handler.start + 8);
      if (!["vide", "soun"].includes(kind)) continue;
      const stsd = child(moov, child(moov, child(moov, mdia, "minf"), "stbl"), "stsd");
      const entries = children(moov, stsd.start + 8, stsd.end);
      if (!entries.length) throw new Error("影片缺少編碼資訊");
      for (const entry of entries) {
        if (kind === "vide") {
          if (!["avc1", "avc3"].includes(entry.type)) throw new Error("請匯出 H.264 MP4，不支援 HEVC／其他編碼");
          child(moov, {start:entry.start+78,end:entry.end}, "avcC");
          videoCodec = "h264";
          const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
          width = view.getUint16(entry.start + 24); height = view.getUint16(entry.start + 26);
        } else {
          if (entry.type !== "mp4a") throw new Error("音訊請匯出 AAC 或移除音訊");
          const esds = child(moov, {start:entry.start+28,end:entry.end}, "esds");
          // ES_Descriptor -> DecoderConfigDescriptor; require MPEG-4 audio (0x40).
          let at = esds.start + 4;
          function descriptor(expected) {
            if (moov[at++] !== expected) throw new Error("不支援的 MP4 音訊");
            let length=0, byte, n=0;
            do { byte=moov[at++]; length=(length<<7)|(byte&127); if(++n>4 || at>esds.end) throw new Error("音訊索引損壞"); } while(byte&128);
            if(at+length>esds.end) throw new Error("音訊索引損壞");
          }
          descriptor(3); at += 2;
          const flags = moov[at++];
          if(flags&128) at+=2; if(flags&64) {const length=moov[at++];at+=length;} if(flags&32) at+=2;
          descriptor(4);
          if(moov[at] !== 0x40) throw new Error("音訊請使用 AAC");
          at+=13; descriptor(5);
          if(![2,5,29].includes(moov[at]>>3)) throw new Error("音訊請使用 AAC-LC 或 HE-AAC");
          audioCodec = "aac";
        }
      }
    }
    if (!videoCodec || !width || !height) throw new Error("MP4 沒有有效影像軌");
    return {size, duration, width, height, videoCodec, audioCodec};
  }
  return Object.freeze({ MAX_BYTES, MAX_SECONDS, sides, groups, complete, validateDraft, inspectMp4 });
});
