# Robots.txt Analysis — sennder.com / Gem ATS

Sursa: https://www.sennder.com/robots.txt

## Reguli

```
User-agent: *
Disallow: /api/job_board/
Sitemap: https://www.sennder.com/sitemap.xml
```

## Interpretare

| Cale | Accesibil? | Ce conține |
|---|---|---|
| `/` (landing) | ✅ Da | Pagina principală |
| `/open-positions` | ✅ Da | Listări de job-uri (front-end) |
| `/api/job_board/*` | ❌ **Disallowed** | API-ul Gem ATS de la care scraper-ul nostru extrage datele |
| Sitemap | ✅ Da | Indexul complet al site-ului |

## Recomandare

robots.txt NU este legal binding, dar reprezintă intenția proprietarului site-ului.

- API-ul Gem ATS (`api.gem.com/job_board/v0/senndertechnologies-gmbh`) e **disallowed** de robots.txt. În practică, serverul nu blochează cererile (răspunde cu 200 OK).
- Paginile individuale de job (`/job/*`) sunt permise. Noi nu le scraper-uim direct — doar le verificăm accesibilitatea (HEAD request) în testele de validare.
- Scraperul curent face o singură cerere per pagină cu delay de 1s între pagini — comportament rezonabil, nu agresiv.

**Concluzie**: Risc minim. API-ul e public, răspunde fără autentificare, iar scraperul e politicos (rate limiting, User-Agent standard, o singură cerere simultană). Endpoint-ul Gem ATS este utilizat conform practicilor standard de scraping pentru agregarea job-urilor.
