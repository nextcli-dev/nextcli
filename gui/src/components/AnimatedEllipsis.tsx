import styled, { keyframes } from "styled-components";

// Reveals the dots one at a time with clip-path, which repaints the dots
// only; animating width would lay out the row on every frame
const ellipsisAnimation = keyframes`
  0% { clip-path: inset(0 100% 0 0); }
  33% { clip-path: inset(0 66% 0 0); }
  66% { clip-path: inset(0 33% 0 0); }
  100% { clip-path: inset(0 0 0 0); }
`;

export const AnimatedEllipsis = styled.span`
  display: inline-block;
  width: 1em; /* Fixed width to match the dots */
  white-space: nowrap;

  &::after {
    content: "...";
    display: inline-block;
    /* An inherited overflow-wrap (such as the thinking row's break-words)
       must not wrap the dots one per line */
    white-space: nowrap;
    width: 1em;
    vertical-align: bottom;
    animation: ${ellipsisAnimation} 2s infinite;
  }
`;

export default AnimatedEllipsis;
