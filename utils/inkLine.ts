export type InkLine = 'full' | 'curvy' | 'dotted';

// CSS for the underline drawn under inked (selected) text.
//  - full:   solid underline
//  - curvy:  a gentle wave (long wavelength so it reads as a soft squiggle, not tight curls)
//  - dotted: sparse dots (thicker than the browser default so the density is lower)
export const inkLineStyle = (inkLine: InkLine, color: string): Record<string, string> => {
  if (inkLine === 'curvy') {
    // Long-wavelength wave SVG, tiled horizontally below the text.
    const svg =
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="5"><path d="M0 3 Q4.5 0.6 9 3 T18 3" fill="none" stroke="${color}" stroke-width="1.1"/></svg>`
      );
    return {
      backgroundImage: `url("${svg}")`,
      backgroundRepeat: 'repeat-x',
      backgroundPosition: '0 100%',
      backgroundSize: '18px 5px',
    };
  }
  return {
    textDecorationLine: 'underline',
    textDecorationStyle: inkLine === 'dotted' ? 'dotted' : 'solid',
    textDecorationColor: color,
    // A thicker dotted line yields bigger, more widely spaced dots — lower density.
    textDecorationThickness: inkLine === 'dotted' ? '2px' : '1px',
    textUnderlineOffset: '4px',
  };
};
