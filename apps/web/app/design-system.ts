import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * The single source of truth for the admin surface. Feature CSS can still
 * describe layout, but component dimensions, semantic colors, and surfaces
 * belong here so new pages inherit the same product language automatically.
 */
export const socioTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#217a67',
    colorInfo: '#217a67',
    colorSuccess: '#27845f',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorText: '#252b28',
    colorTextSecondary: '#717972',
    colorTextTertiary: '#929a92',
    colorBgBase: '#ffffff',
    colorBgLayout: '#f6f7f5',
    colorBgContainer: '#ffffff',
    colorFillAlter: '#f7f8f6',
    colorBorder: '#dfe3df',
    colorBorderSecondary: '#e8ebe5',
    borderRadius: 8,
    borderRadiusSM: 6,
    borderRadiusLG: 12,
    controlHeight: 40,
    controlHeightSM: 32,
    controlHeightLG: 48,
    fontSize: 14,
    fontSizeSM: 12,
    fontFamily: '"Segoe UI Variable", "Segoe UI", ui-sans-serif, system-ui, sans-serif',
    lineHeight: 1.5,
  },
  components: {
    Button: {
      borderRadius: 8,
      controlHeight: 40,
      controlHeightSM: 32,
      controlHeightLG: 48,
      fontWeight: 600,
      primaryShadow: 'none',
      defaultShadow: 'none',
    },
    Card: {
      borderRadiusLG: 12,
      headerHeight: 64,
      bodyPadding: 24,
      headerPadding: 24,
    },
    Input: {
      activeShadow: '0 0 0 3px rgba(33, 122, 103, 0.12)',
      hoverBorderColor: '#7fb7a7',
    },
    Select: {
      activeOutlineColor: 'rgba(33, 122, 103, 0.12)',
      optionSelectedBg: '#eaf3ee',
    },
    Table: {
      headerBg: '#f7f8f6',
      headerColor: '#687267',
      headerSplitColor: '#e8ebe5',
      cellPaddingBlock: 14,
      cellPaddingInline: 16,
      rowHoverBg: '#f8faf6',
    },
    Modal: {
      contentBg: '#ffffff',
      headerBg: '#ffffff',
      titleFontSize: 19,
      titleLineHeight: 1.35,
    },
    Drawer: {
      colorBgElevated: '#ffffff',
      footerPaddingBlock: 16,
      footerPaddingInline: 24,
    },
    Tabs: {
      itemSelectedColor: '#217a67',
      itemHoverColor: '#217a67',
      inkBarColor: '#217a67',
    },
    Tag: {
      borderRadiusSM: 5,
      defaultBg: '#f7f8f6',
      defaultColor: '#59645b',
    },
    Menu: {
      itemBorderRadius: 8,
      itemHeight: 42,
      itemSelectedBg: '#e8efe7',
      itemSelectedColor: '#315c45',
    },
  },
};

