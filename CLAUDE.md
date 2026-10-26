# Kassakoll

Budgethemsida på svenska. Ren HTML, CSS och JavaScript utan byggsteg.

## Filer
- index.html: sidans struktur (flikarna Budget = planering, Spenderat = utfall mot budget, Kvitton, Saldo = kontots utveckling; två dialoger)
- styles.css: utseende, färger som variabler överst, mörkt läge via prefers-color-scheme
- app.js: all logik (budget, kvittolista, dialoger, OCR-flödet)
- db.js: lagring med samma gränssnitt i två lägen: lokalt (IndexedDB: "receipts" med bildblob, "plans" per månad, "settings") eller moln (Supabase, allt cachas i minnet, bilder som signerade länkar)
- config.js: Supabase-URL och anon-nyckel. Tomma = lokalt läge utan inloggning.
- supabase.sql: tabell kassakoll_items + bucket "kvitton" med RLS (klistras in i Supabase SQL Editor)
- LAS-MIG.txt: guide för GitHub Pages och Supabase
- parse.js: tolkar OCR-text till butik, datum, summa, kategori (kan testas i Node: require('./parse.js'))

## Köra lokalt
Dubbelklicka starta.bat eller kör `python -m http.server 8000` / `npx serve` i mappen.
Öppna http://localhost:8000

## Regler
- Svenska i all text som användaren ser.
- Inga ramverk eller byggsteg. Klassiska script, inte ES-moduler.
- Kvittoläsning sker med Tesseract.js (laddas från CDN vid första scanningen).

## Nästa steg
- Export och import av backup (JSON).

## Konton
Kategorierna kallas konton och är redigerbara (settings/accounts: id, name, color, fallback).
Standardkontonas id är namnet ("Mat") så att äldre kvitton funkar; nya konton får uid. receipt.category = konto-id.
Budget per konto sparas per månad i plan.limits[id]. allocate() i app.js tar varje kvitto (i datumordning) från sitt konto,
överdrag från kontots fallback (kedja), till sist från Buffert = inkomster minus budgeterat.

## Saldo
settings/balance: { anchors: [{date, amount, createdAt}], payday }. Ett ankare = saldo som användaren skrev in.
buildBalance() i app.js går dag för dag från första ankaret: köp dras på sina datum, inkomster från månadens plan
(sparad eller ärvd) läggs till på lönedagen. Ett nytt ankare sätter saldot. Diagrammet är egen SVG, inga bibliotek.
Mål (settings/goals): type 'balance' = nå saldo (jämförs med saldot), 'save' = spara belopp (saldot nu minus startBalance
när målet skapades). Uppskattning från genomsnittlig ökning per dag senaste 90 dagarna.

## Inloggning
Om config.js är ifylld laddas supabase-js (CDN) och startCloud() i app.js visar inloggningen (#auth) före allt annat.
Efter inloggning DB.useCloud(); är molnet tomt flyttas lokal IndexedDB-data upp (migrateLocal, lokal kopia ligger kvar).
Kvittobilder kan vara Blob eller URL-sträng: använd imageUrl()/freeUrl() i app.js, inte URL.createObjectURL direkt.
