window.CASE_DATA_SCHEMA_VERSION = 2;

/*
Case records are intentionally separate from index.html so future updates only
need to add a record and its authorized WebP images. Public rendering requires
both status: "published" and consentConfirmed: true.

Example shape:
{
  id: "case-0001",
  title: "中下臉輪廓與膚質改善",
  status: "draft",
  displayOrder: 10,
  concernTags: ["輪廓鬆弛", "法令紋"],
  treatmentIds: ["oligio-x", "belotero"],
  beforeAfterPairs: [
    {
      label: "正面",
      followUpLabel: "療程後三個月",
      canvasRatio: "4:3",
      splitDirection: "horizontal",
      before: {
        src: "assets/images/cases/case-0001/before-front.webp",
        alt: "案例 case-0001 正面術前"
      },
      after: {
        src: "assets/images/cases/case-0001/after-front.webp",
        alt: "案例 case-0001 正面術後"
      }
    }
  ],
  summary: "案例改善重點摘要。",
  consentConfirmed: false
}
*/
window.CASE_DATA = [];
