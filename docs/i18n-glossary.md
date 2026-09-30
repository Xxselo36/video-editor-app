---
# docs/ is also the source of the getsmartcut.app GitHub Pages site:
# keep this file out of it.
published: false
---

# i18n glossary

One approved term per language for CleoCuts' core concepts, so that for
example "Schnitt" means the same thing on every screen. Every new or
changed message in `web/src/i18n/messages` uses these terms
(PLAN_TECH rule 0.8).

`npm run i18n:check` (web/scripts/i18n-check.mjs, run by CI on every
web change) reads this file: it warns when a message uses a term from
the **Avoid** table for its language. Warnings don't fail the build yet;
existing deviations are fixed where their screens are rebuilt (render →
export in UX11, German texts in UX3, the rest in UX16).

Status: proposal of UX1 (2026-09-30), taken from the current
translations and the plan's decisions (German: Schnitt, Untertitel-Stil,
Exportieren, Projekt). Native-speaker review: de, es, fr, pt in UX16;
the other languages follow the same pattern. Change a term here first,
then the messages.

## Concepts

| Concept | Meaning in CleoCuts |
|---|---|
| Take | One continuous recording attempt. "Cleo cut" throws the current take away; the analysis keeps the good takes. |
| Cut | A removed range of the video (a pause, a filler word, a failed take). The timeline lists the cuts; one can be restored. |
| Caption style | The look of the burned-in captions (Clipper, Clean, …). Not the social-media caption (post text) of a finished video. |
| Minutes | The plan's unit: minutes of uploaded video per month. |
| Export | Producing the final video file(s) on the server. Today's UI still says "render" ("Apply & render"); UX11 renames it. |
| Project | One uploaded video with its edits and exports (Library today, Projects page from UX12). |
| Preview | Playing the edit in the browser before exporting. |
| Edit again | Reopening a finished export in the editor to change it (UX11). |

## Terms

Nouns as they appear in the UI; a verb form in parentheses where the UI
uses both.

| Concept | en | de | es | fr | pt | it | tr | pl | nl | ru | ja | ko | id | hi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Take | take | Take | toma | prise | tomada | ripresa | çekim | ujęcie | take | дубль | テイク | 촬영분 | take | टेक |
| Cut | cut | Schnitt | corte | coupe | corte | taglio | kesim | cięcie | knip | вырезка | カット | 컷 | potongan | कट |
| Caption style | caption style | Untertitel-Stil | estilo de subtítulos | style de sous-titres | estilo de legenda | stile sottotitoli | altyazı stili | styl napisów | ondertitelstijl | стиль субтитров | 字幕スタイル | 자막 스타일 | gaya teks | कैप्शन स्टाइल |
| Minutes | minutes | Minuten | minutos | minutes | minutos | minuti | dakika | minuty | minuten | минуты | 利用時間（分） | 이용 시간(분) | menit | मिनट |
| Export | export | Export (exportieren) | exportación (exportar) | export (exporter) | exportação (exportar) | esportazione (esportare) | dışa aktarma (dışa aktar) | eksport (eksportuj) | export (exporteren) | экспорт (экспортировать) | 書き出し | 내보내기 | ekspor | एक्सपोर्ट |
| Project | project | Projekt | proyecto | projet | projeto | progetto | proje | projekt | project | проект | プロジェクト | 프로젝트 | proyek | प्रोजेक्ट |
| Preview | preview | Vorschau | vista previa | aperçu | prévia | anteprima | önizleme | podgląd | voorbeeld | превью | プレビュー | 미리보기 | pratinjau | प्रीव्यू |
| Edit again | edit again | erneut bearbeiten | editar de nuevo | modifier à nouveau | editar de novo | modifica di nuovo | yeniden düzenle | edytuj ponownie | opnieuw bewerken | редактировать снова | 再編集 | 다시 편집 | edit lagi | फिर से एडिट करें |

Notes:

- The voice commands ("Cleo cut", "Cleo go", …) and the style names
  (Clipper, Clean, …) stay in English in every language; the check
  ignores them.
- "Montage" / "montaggio" / "montaż" / "монтаж" mean the edit as a
  whole (fine-tune the cut), not a single cut — both are fine.
- fr "légende", es "descripción", pt "legenda" (post text) name the
  social-media caption, a different concept from the caption style.
- pt is Brazilian Portuguese ("legenda", "prévia"), es is neutral Latin
  American ("video").

## Avoid

What the check looks for, per language and concept. Comma-separated;
case is ignored; whole words unless `*` allows more letters on that
side (`render*` catches "rendern" and "Rendering", not "prendere").
Japanese, Korean and Hindi match anywhere in the text.

| Lang | Concept | Avoid |
|---|---|---|
| en | Export | `render*` |
| de | Cut | `Cut` |
| de | Caption style | `Caption-Stil`, `Captions-Stil`, `Untertitelstil*` |
| de | Export | `render*`, `gerendert` |
| de | Preview | `Preview` |
| es | Export | `renderiz*` |
| es | Preview | `previsualizaci*` |
| fr | Export | `rendu*` |
| fr | Preview | `prévisualisation*` |
| pt | Caption style | `subtítulo*` |
| pt | Export | `renderiz*` |
| pt | Preview | `pré-visualiza*` |
| it | Export | `render*` |
| it | Preview | `preview` |
| tr | Export | `render*` |
| pl | Export | `render*`, `wyrender*` |
| pl | Preview | `preview` |
| nl | Cut | `snede`, `sneden` |
| nl | Export | `render*` |
| nl | Preview | `preview` |
| ru | Export | `рендер*` |
| ru | Preview | `предпросмотр*` |
| ja | Minutes | `分数` |
| ja | Export | `レンダリング`, `エクスポート` |
| ko | Take | `테이크` |
| ko | Export | `렌더링`, `익스포트` |
| id | Caption style | `subtitle*` |
| id | Export | `render*`, `merender`, `dirender` |
| id | Preview | `preview` |
| hi | Export | `रेंडर` |
| hi | Preview | `पूर्वावलोकन` |
| hi | Project | `परियोजना` |
