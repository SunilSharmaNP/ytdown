# Vercel पर API deploy करना

इस project में Vercel serverless function मौजूद है:

```text
api/youtube.js
```

Deploy होने के बाद इसका URL होगा:

```text
https://YOUR-DOMAIN.vercel.app/api/youtube
```

## POST से इस्तेमाल

```bash
curl -X POST "https://YOUR-DOMAIN.vercel.app/api/youtube" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://youtu.be/o6OTjEHms6g?si=g-sFwv0chPhdfUK7"}'
```

## Browser से GET testing

Browser में यह URL खोलें:

```text
https://YOUR-DOMAIN.vercel.app/api/youtube?url=https%3A%2F%2Fyoutu.be%2Fo6OTjEHms6g
```

## Vercel CLI

Project root से:

```bash
npm i -g vercel
vercel
vercel --prod
```

यह function किसी API key या environment variable पर निर्भर नहीं है।
