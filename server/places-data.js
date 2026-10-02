// Built-in popular pickup and drop-off points, loaded into the places table on
// first start. Coordinates are approximate (to within about a kilometre); admins
// can correct them or add more in Admin → Places, e.g. by copying the
// coordinates of a pin from Google Maps.
//
// [city, name, latitude, longitude]
module.exports = [
  ['Abbottabad', 'City centre (Fawara Chowk)', 34.1688, 73.2215],
  ['Abbottabad', 'Supply Bazaar', 34.1980, 73.2420],

  ['Bahawalpur', 'City centre (Farid Gate)', 29.3956, 71.6836],
  ['Bahawalpur', 'Islamia University', 29.3770, 71.7640],

  ['Faisalabad', 'Clock Tower (Ghanta Ghar)', 31.4187, 73.0791],
  ['Faisalabad', 'D-Ground, Peoples Colony', 31.3990, 73.1080],
  ['Faisalabad', 'University of Agriculture', 31.4300, 73.0700],

  ['Gujranwala', 'City centre (Sheranwala Bagh)', 32.1617, 74.1883],
  ['Gujranwala', 'GT Road, Chanda Qila', 32.1870, 74.1960],

  ['Gujrat', 'City centre (Shah Daula Road)', 32.5739, 74.0789],

  ['Hyderabad', 'Qasimabad', 25.3960, 68.3270],
  ['Hyderabad', 'Latifabad', 25.3710, 68.3790],
  ['Hyderabad', 'Hala Naka', 25.4380, 68.3400],

  ['Islamabad', 'Faizabad Interchange', 33.6640, 73.0820],
  ['Islamabad', 'Zero Point', 33.6939, 73.0460],
  ['Islamabad', 'G-9 Markaz (Karachi Company)', 33.6890, 73.0300],
  ['Islamabad', 'Blue Area (Jinnah Avenue)', 33.7104, 73.0571],
  ['Islamabad', 'F-6 Super Market', 33.7255, 73.0760],
  ['Islamabad', 'Islamabad International Airport', 33.5490, 72.8250],

  ['Jhelum', 'City centre (GT Road)', 32.9405, 73.7276],

  ['Karachi', 'Sohrab Goth', 24.9450, 67.0850],
  ['Karachi', 'Saddar (Empress Market)', 24.8606, 67.0291],
  ['Karachi', 'Clifton (Teen Talwar)', 24.8340, 67.0330],
  ['Karachi', 'Gulshan-e-Iqbal (NIPA Chowrangi)', 24.9175, 67.0975],
  ['Karachi', 'Jinnah International Airport', 24.9065, 67.1608],

  ['Lahore', 'Thokar Niaz Baig', 31.4705, 74.2407],
  ['Lahore', 'Kalma Chowk', 31.5040, 74.3310],
  ['Lahore', 'Liberty Market, Gulberg', 31.5107, 74.3443],
  ['Lahore', 'Johar Town (Emporium Mall)', 31.4676, 74.2660],
  ['Lahore', 'DHA Phase 5', 31.4710, 74.4100],
  ['Lahore', 'Shahdara (Ravi Bridge)', 31.6230, 74.2870],
  ['Lahore', 'Allama Iqbal International Airport', 31.5216, 74.4036],

  ['Mardan', 'City centre', 34.1986, 72.0404],

  ['Multan', 'Ghanta Ghar', 30.1980, 71.4710],
  ['Multan', 'Multan Cantt', 30.1890, 71.4400],
  ['Multan', 'Bahauddin Zakariya University', 30.2610, 71.5130],

  ['Murree', 'Mall Road', 33.9070, 73.3943],

  ['Peshawar', 'Hayatabad', 33.9970, 71.4440],
  ['Peshawar', 'Saddar', 34.0040, 71.5430],
  ['Peshawar', 'University Town', 34.0130, 71.5000],

  ['Quetta', 'City centre (Jinnah Road)', 30.1920, 67.0070],

  ['Rahim Yar Khan', 'City centre', 28.4202, 70.2952],

  ['Rawalpindi', 'Saddar', 33.5970, 73.0480],
  ['Rawalpindi', 'Committee Chowk', 33.6146, 73.0657],
  ['Rawalpindi', 'Pir Wadhai', 33.6390, 73.0390],

  ['Sahiwal', 'City centre', 30.6682, 73.1114],

  ['Sargodha', 'City centre', 32.0836, 72.6711],

  ['Sialkot', 'City centre (Allama Iqbal Chowk)', 32.4945, 74.5229],
  ['Sialkot', 'Sialkot International Airport', 32.5356, 74.3639],

  ['Sukkur', 'City centre', 27.7052, 68.8574],

  // ---- Added in version 1.3: more points in big cities, more cities ----
  ['Lahore', 'Babu Sabu Interchange', 31.5620, 74.2540],
  ['Lahore', 'Railway Station', 31.5770, 74.3360],
  ['Lahore', 'Qainchi (Ferozepur Road)', 31.4690, 74.3230],
  ['Lahore', 'Model Town Link Road', 31.4840, 74.3240],
  ['Lahore', 'Punjab University (New Campus)', 31.4810, 74.3000],
  ['Lahore', 'Wapda Town Roundabout', 31.4320, 74.2680],
  ['Lahore', 'Bahria Town (Main Gate)', 31.3650, 74.1850],
  ['Lahore', 'Ring Road, Mehmood Booti', 31.5960, 74.3890],

  ['Islamabad', 'Peshawar Mor (G-9/H-8)', 33.6840, 73.0420],
  ['Islamabad', 'NUST (H-12)', 33.6430, 72.9900],
  ['Islamabad', 'I-8 Markaz', 33.6680, 73.0760],
  ['Islamabad', 'Koral Chowk (Expressway)', 33.6160, 73.1360],
  ['Islamabad', 'COMSATS University (Park Road)', 33.6510, 73.1570],
  ['Islamabad', 'F-10 Markaz', 33.6950, 73.0130],

  ['Rawalpindi', 'Chandni Chowk', 33.6290, 73.0710],
  ['Rawalpindi', '6th Road (Metro station)', 33.6370, 73.0750],
  ['Rawalpindi', 'Bahria Town Civic Centre', 33.5320, 73.1070],
  ['Rawalpindi', 'Rawat (GT Road)', 33.4960, 73.1960],

  ['Karachi', 'Cantt Railway Station', 24.8440, 67.0400],
  ['Karachi', 'Johar Mor (Gulistan-e-Jauhar)', 24.9050, 67.1150],
  ['Karachi', 'Five Star Chowrangi (North Nazimabad)', 24.9470, 67.0410],
  ['Karachi', 'Malir Halt', 24.8945, 67.1890],
  ['Karachi', 'University of Karachi', 24.9450, 67.1140],

  ['Faisalabad', 'Faisalabad Motorway Interchange', 31.4930, 73.1660],
  ['Faisalabad', 'Satiana Road (Kohinoor City)', 31.3990, 73.0530],

  ['Peshawar', 'Board Bazaar', 34.0010, 71.4880],
  ['Peshawar', 'Peshawar Motorway Toll Plaza', 34.0600, 71.5650],

  ['Multan', 'Chowk Kumharanwala', 30.2050, 71.4980],
  ['Multan', 'Multan Motorway Interchange', 30.2710, 71.4180],

  ['Gujranwala', 'Gujranwala Cantt', 32.2320, 74.1520],
  ['Sialkot', 'Sialkot Cantt', 32.5170, 74.5520],
  ['Abbottabad', 'Mandian', 34.1810, 73.2370],
  ['Hyderabad', 'Hyderabad Motorway Toll Plaza (M-9)', 25.4200, 68.2700],

  ['Attock', 'City centre', 33.7660, 72.3609],
  ['Chakwal', 'City centre', 32.9328, 72.8630],
  ['Chiniot', 'City centre', 31.7200, 72.9789],
  ['Dera Ghazi Khan', 'City centre', 30.0561, 70.6348],
  ['Dera Ismail Khan', 'City centre', 31.8314, 70.9019],
  ['Gilgit', 'City centre', 35.9208, 74.3080],
  ['Hafizabad', 'City centre', 32.0709, 73.6880],
  ['Haripur', 'City centre', 33.9946, 72.9341],
  ['Jhang', 'City centre', 31.2681, 72.3181],
  ['Kasur', 'City centre', 31.1187, 74.4508],
  ['Khanewal', 'City centre', 30.3017, 71.9321],
  ['Kohat', 'City centre', 33.5869, 71.4429],
  ['Larkana', 'City centre', 27.5570, 68.2264],
  ['Mandi Bahauddin', 'City centre', 32.5861, 73.4917],
  ['Mansehra', 'City centre', 34.3302, 73.1968],
  ['Mianwali', 'City centre', 32.5839, 71.5370],
  ['Mirpur (AJK)', 'City centre', 33.1484, 73.7518],
  ['Mirpur Khas', 'City centre', 25.5276, 69.0111],
  ['Muzaffarabad', 'City centre', 34.3700, 73.4711],
  ['Nawabshah', 'City centre', 26.2442, 68.4100],
  ['Nowshera', 'City centre', 34.0153, 71.9747],
  ['Okara', 'City centre', 30.8138, 73.4534],
  ['Sheikhupura', 'City centre', 31.7131, 73.9783],
  ['Skardu', 'City centre', 35.2971, 75.6333],
  ['Swat (Mingora)', 'City centre', 34.7717, 72.3600],
  ['Taxila', 'City centre', 33.7463, 72.8397],
  ['Wah Cantt', 'City centre', 33.7972, 72.7280],
];
