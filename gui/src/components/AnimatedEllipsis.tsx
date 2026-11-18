import styled, { keyframes } from "styled-components";

const ellipsisAnimation = keyframes`
  0% { width: 0; }
  33% { width: 0.33em; }
  66% { width: 0.66em; }
  100% { width: 1em; }
`;

export const AnimatedEllipsis = styled.span`
  display: inline-block;
  width: 1em; /* Fixed width to match the maximum animation width */
  white-space: nowrap;

  &::after {
    content: "...";
    display: inline-block;
    /* While the box is narrower than the dots, an inherited overflow-wrap
       (such as the thinking row's break-words) would wrap them one per line */
    white-space: nowrap;
    overflow: hidden;
    vertical-align: bottom;
    animation: ${ellipsisAnimation} 2s infinite;
    width: 0;
  }
`;

export default AnimatedEllipsis;
