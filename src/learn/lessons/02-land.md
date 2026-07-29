Before there were people in Harbour Reach, there was the land — and the land is a **function**.

The map below is not an image. No PNG was downloaded; there is nothing to download. Every pixel is
the answer to a question: *"how high is the world at this point?"* — asked of a little mathematical
oracle called **fractal noise**, seeded by the same coin as Chapter I.

## The teaching

Layered noise — *fractal Brownian motion*, fBm to its friends — is the oldest trick in procedural
worldbuilding, and it is barely thirty lines of JavaScript:

```
height(x, y) =   ½ · noise(x,      y)        the continents
              + ¼ · noise(2x,     2y)        the hills
              + ⅛ · noise(4x,     4y)        the boulders
              + …                            each octave finer and fainter
```

One smooth random function, sampled at doubling frequencies and halving volumes, gives you
coastlines, archipelagos and mountain spines. Slide the **sea level** and watch geography become
politics: harbours open and close, islands join and secede. Add **octaves** and watch detail pour
in — that slider is a *budget dial*, the same trade the real engine makes when it degrades bake
resolution instead of dropping content.

This is the JAMStack lesson in its purest form: the classic stack ships *data* (a 4 MB terrain
image); the JAMStack at its boldest ships *the recipe* (thirty lines) and lets the client cook.
IRONSIGHT takes this to the limit — its 2048² terrain, with sixty-four iterations of hydraulic
erosion, is baked on your GPU when the game loads. Zero art assets in the repository. The land is
source code.

## Lift the curtain

- This page's miniature: `src/learn/proc.ts` — `valueNoise2`, `fbm2`, `heightAt`, ~90 lines.
- The real thing: `src/bake/noise.ts` ships *matched CPU and GLSL implementations* of its noise,
  because the physics must stand on exactly the hill the shader draws. Same-land-for-everyone is
  a **contract** — in this academy the contract is that every chapter imports `heightAt` from one
  file, and the villagers of Chapter III walk on precisely the terrain you are looking at now.
