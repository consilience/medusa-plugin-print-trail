import en from "./json/en.json" with { type: "json" }

// One namespace for the plugin's strings: components call
// useTranslation("printTrail"); routes pass translationNs: "printTrail".
export default {
  en: {
    printTrail: en,
  },
}
