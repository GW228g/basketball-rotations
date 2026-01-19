# Favicon Setup Instructions

The app includes an SVG favicon (`favicon.svg`) that works in modern browsers. For full compatibility and home screen icons, you'll need to generate PNG versions.

## Required PNG Sizes

You need to create these PNG files from `favicon.svg`:
- `favicon-180.png` - 180x180 (for Apple touch icon)
- `favicon-192.png` - 192x192 (for Android)
- `favicon-512.png` - 512x512 (for Android)

## How to Generate

### Option 1: Online Tool
1. Go to https://convertio.co/svg-png/ or similar SVG to PNG converter
2. Upload `favicon.svg`
3. Convert to PNG at the required sizes
4. Save as `favicon-180.png`, `favicon-192.png`, and `favicon-512.png`

### Option 2: Using ImageMagick (command line)
```bash
convert -background none -resize 180x180 favicon.svg favicon-180.png
convert -background none -resize 192x192 favicon.svg favicon-192.png
convert -background none -resize 512x512 favicon.svg favicon-512.png
```

### Option 3: Using Inkscape (command line)
```bash
inkscape --export-type=png --export-width=180 --export-filename=favicon-180.png favicon.svg
inkscape --export-type=png --export-width=192 --export-filename=favicon-192.png favicon.svg
inkscape --export-type=png --export-width=512 --export-filename=favicon-512.png favicon.svg
```

The SVG favicon will work for basic browser tabs, but the PNG files are needed for:
- Home screen icons on iOS/Android
- Better compatibility across all browsers
- PWA manifest icons
