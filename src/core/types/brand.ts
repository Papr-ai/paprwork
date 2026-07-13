/** Structured brand tokens for mini-apps and agent UI work. */
export interface BrandSource {
  date: string;
  chat?: string;
  appId?: string;
  note: string;
}

export interface BrandColors {
  primary?: string;
  accent?: string;
  background?: string;
  text?: string;
}

export interface BrandFonts {
  heading?: string;
  body?: string;
}

export interface BrandLogo {
  light?: string;
  dark?: string;
}

export interface BrandTokens {
  name?: string;
  colors?: BrandColors;
  fonts?: BrandFonts;
  logo?: BrandLogo;
  voice?: string;
  sources?: BrandSource[];
}

export const EMPTY_BRAND_TOKENS: BrandTokens = {
  name: "",
  colors: {
    primary: "",
    accent: "",
    background: "",
    text: "",
  },
  fonts: {
    heading: "",
    body: "",
  },
  logo: {
    light: "",
    dark: "",
  },
  voice: "",
  sources: [],
};
