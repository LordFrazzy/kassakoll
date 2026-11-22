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
Inloggning är frivillig: "Fortsätt utan att logga in" (#auth-skip) sparar localStorage 'kassakoll-utan-inloggning' = '1'
och kör lokalt läge; knappen #login-btn i toppen tar bort valet och laddar om. Når appen inte molnet visar bannern "Använd utan inloggning".
Kvittobilder kan vara Blob eller URL-sträng: använd imageUrl()/freeUrl() i app.js, inte URL.createObjectURL direkt.

## Spenderat: betyg och grafer
gradeFor(månad) i app.js: 60 % håller kontona (överdrag/budget, 50 % över = helt missat), 40 % sparande
(andel av inkomsten som blir över, 20 % = full pott). Pågående månad = prognos. Bokstav A–F.
drawPace() = spenderat dag för dag mot jämn takt, drawMonths() = 6 månader staplar. Klick på månad -> gotoMonth().

## Från bankappen
Skärmdump(ar) av kontohändelser -> scanBank() i app.js: prepareScreenshot() (förstorar, vänder mörkt läge, färgad text blir mörk),
Tesseract psm 6 (psm 4 om få rader), KvittoParse.parseBank() i parse.js ger rader {store, date, amount, incoming, category}.
Datumrubriker ("Idag", "Igår", "Fre 20 nov") gäller raderna under. Andra belopp på en rad = saldo, ignoreras.
Användarens bank: namn + belopp på en rad, sifferdatum (2026-11-21, ev. med saldo) på raden UNDER -> dateBelow i parseBank.
Minus läses också som ~ = —. Visar bilden ören (showsOre) blir heltal utan "kr" ören som tappat kommat ("-24550" = 245,50, flaggas).
Dubbletter mellan överlappande bilder tas bort, men likadana köp i samma bild behålls (två bussbiljetter samma dag).
Statusord ("Prel", "Swish", "Kortköp") slängs bara som egen rad; i början av ett namn är de en del av köpet.
Heltal sist på raden räknas som ören om banken visar ören (OCR tappar både minus och komma). Saknas minus på
många rader litar vi inte på tecknet (bara + och "Lön" m.fl. = pengar in).
ocrScreenshot() i app.js läser med psm 11 (gles text) och bygger raderna själv av ordens position (mittpunkt inom halva
radhöjden = samma rad), eftersom användarens bank har beloppet mitt emellan namn- och datumraden; då blandar Tesseracts
egen radindelning ihop allt. Korta ord med låg säkerhet (ikoner) tas bort; stripAvatar() i parse.js tar bort bokstavsikonen
("H Hemköp"). Andra läsningen (psm 6) körs om < 3 köp eller färre köp än sifferdatum i texten.
Belopp med punkt ("-94.00") får inte tas för datum: maskDates() tar bara giltiga dag/månad och inte efter minustecken.
Heltal utan minus räknas som belopp bara när OCR tappar kommat oftare än det läser det (läge 2), så "McDonalds 7520" är ett namn.
Granskning i #bank-dialog: pengar in och troliga dubbletter är urbockade.
Dubbletter: matchScore()/findMatch() i app.js väger belopp, datum och butiksnamn (sameStore: gemensamt ord,
Swish kräver exakt samma mottagare). Kvitto mot bank: samma belopp + samma butik inom 10 dagar, eller samma belopp
inom 2 dagar. Bank mot bank (sparat köp med note "Från bankappen"): samma butik, belopp OCH samma dag, annars är det
ett nytt köp (busskort, Qick, prenumerationer återkommer med samma belopp). Paren väljs bäst först, varje sparat köp
paras bara med en rad. Nytt kvitto som matchar ett sparat köp: #match-box frågar "koppla ihop"
(sparas över det befintliga med kvittots uppgifter och bild) eller "annat köp". Sparas som kvitton utan bild,
note "Från bankappen". Valt konto per butik minns i settings/merchants (map: merchantKey -> konto-id).

## Publicera
index.html laddar filerna med ?v=ÅÅÅÅMMDDTTMM. Byt numret vid varje publicering (sed på "?v=") så att mobiler inte kör
gamla filer (GitHub Pages cachar i 10 min). Bankdialogens "Kopiera texten" visar version, bildstorlek och läsläge.

## Menyn
Flikarna har adresser: #budget, #spenderat, #kvitton, #saldo (ROUTES i app.js). navigate() sätter hash, hashchange byter vy.
Glidande markering .tab-ind placeras av moveIndicator().
