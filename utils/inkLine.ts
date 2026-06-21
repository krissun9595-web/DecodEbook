export type InkLine = 'full' | 'curvy' | 'dotted';

// CSS for the underline drawn under inked (selected) text.
//  - full:   solid underline
//  - curvy:  a gentle wave (long wavelength so it reads as a soft squiggle, not tight curls)
//  - dotted: sparse dots (thicker than the browser default so the density is lower)
export const inkLineStyle = (inkLine: InkLine, color: string): Record<string, string> => {
  if (inkLine === 'curvy') {
    // One full wave per 18px. The path starts and ends at y=2.5 with the same slope,
    // so tiles join seamlessly (no cracks), and the amplitude stays within the 5px
    // height so the stroke isn't clipped. paddingBottom drops it clear of the text.
    const svg =
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="5"><path d="M0 2.5 Q4.5 0.5 9 2.5 T18 2.5" fill="none" stroke="${color}" stroke-width="1"/></svg>`
      );
    return {
      backgroundImage: `url("${svg}")`,
      backgroundRepeat: 'repeat-x',
      backgroundPosition: '0 100%',
      backgroundSize: '18px 5px',
      paddingBottom: '5px',
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
