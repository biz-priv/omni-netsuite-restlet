function getBusinessSegment(env) {
  const data = {
    DEV: {
      domestic: "2",
      international: "3",
      warehouse: "16",
      vas: "44",
      administration: "8",
      "balance sheet": "9",
      customs: "15",
      "local delivery": "17",
      wh1: "18",
      stw: "19",
      wc12: "20",
      wc18: "21",
      tx12: "22",
      tx18: "23",
      tx19: "24",
      tx23: "25",
      gtwc11: "26",
      gtwc13: "27",
      gtwc16: "28",
      gtwc20: "29",
      gtwc26: "30",
      gtwc28: "31",
      gtwc30: "32",
      "value added services": "33",
      "system level testing": "34",
      sorting: "35",
      wine: "36",
      wh2: "37",
      wh3: "38",
      wh4: "39",
      wh5: "40",
      "face mask": "41",
      wholesale: "42",
      "e-commerce": "43",
      storage: "45",
      returns: "46",
      receiving: "47",
      edi: "48",
      "administration - addback": "49",
      "ground standard": "50",
      tl: "51",
      expedite: "52",
      air: "53",
      ocean: "54",
      "warehouse/vas": "55",
      "small pack": "56",
      "customs brokerage": "57",
    },
    PROD: {
      domestic: "2",
      international: "3",
      warehouse: "16",
      vas: "44",
      administration: "8",
      "balance sheet": "9",
      customs: "15",
      "local delivery": "17",
      wh1: "18",
      stw: "19",
      wc12: "20",
      wc18: "21",
      tx12: "22",
      tx18: "23",
      tx19: "24",
      tx23: "25",
      gtwc11: "26",
      gtwc13: "27",
      gtwc16: "28",
      gtwc20: "29",
      gtwc26: "30",
      gtwc28: "31",
      gtwc30: "32",
      "value added services": "33",
      "system level testing": "34",
      sorting: "35",
      wine: "36",
      wh2: "37",
      wh3: "38",
      wh4: "39",
      wh5: "40",
      "face mask": "41",
      wholesale: "42",
      "e-commerce": "43",
      storage: "45",
      returns: "46",
      receiving: "47",
      edi: "48",
      "administration - addback": "49",
      "ground standard": "50",
      tl: "51",
      expedite: "52",
      air: "53",
      ocean: "54",
      "warehouse/vas": "55",
      "small pack": "56",
      "customs brokerage": "57",
    },
  };
  return data[env.toUpperCase()];
}

module.exports = {
  getBusinessSegment,
};