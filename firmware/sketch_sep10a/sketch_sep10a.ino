#include <SPI.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <Fuzzy.h>

// Hardware Pinout
#define PIN_RPWM 25
#define PIN_LPWM 26
#define PIN_RELAY 32      // Pin Relay Mist Maker (Active HIGH)
#define SHT31_ADDR 0x45

TFT_eSPI tft = TFT_eSPI();
Adafruit_SHT31 sht31 = Adafruit_SHT31();
Fuzzy *fuzzy = new Fuzzy();

// Variable System
float tempSensor = 0.0, rhSensor = 0.0;
float setpointTemp = 25.0, setpointRH = 65.0;
bool systemRunning = false;
bool wifiOnline = false;

// Popup Keyboard State (0: Closed, 1: Edit Temp, 2: Edit RH)
int keyboardState = 0; 
String keyboardBuffer = "";
unsigned long lastTouch = 0, lastSensRead = 0;

// Lopaka Bitmaps
static const unsigned char PROGMEM image_music_play_button_bits[] = {0x00,0x3f,0xf0,0x00,0x00,0x3f,0xf0,0x00,0x03,0xc0,0x0f,0x00,0x03,0xc0,0x0f,0x00,0x0c,0x00,0x00,0xc0,0x0c,0x00,0x00,0xc0,0x30,0x00,0x00,0x30,0x30,0x00,0x00,0x30,0x30,0xf0,0x00,0x30,0x30,0xf0,0x00,0x30,0xc0,0xcf,0xc0,0x0c,0xc0,0xcf,0xc0,0x0c,0xc0,0xc0,0x3c,0x0c,0xc0,0xc0,0x3c,0x0c,0xc0,0xc0,0x03,0xcc,0xc0,0xc0,0x03,0xcc,0xc0,0xc0,0x3c,0x0c,0xc0,0xc0,0x3c,0x0c,0xc0,0xcf,0xc0,0x0c,0xc0,0xcf,0xc0,0x0c,0x30,0xf0,0x00,0x30,0x30,0xf0,0x00,0x30,0x30,0x00,0x00,0x30,0x30,0x00,0x00,0x30,0x0c,0x00,0x00,0xc0,0x0c,0x00,0x00,0xc0,0x03,0xc0,0x0f,0x00,0x03,0xc0,0x0f,0x00,0x00,0x3f,0xf0,0x00,0x00,0x3f,0xf0,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00};
static const unsigned char PROGMEM image_plant_bits[] = {0x00,0x03,0x00,0x0f,0x20,0x1f,0x70,0x3f,0xf8,0x3f,0xfc,0x7e,0xfc,0x7e,0xfc,0x7c,0x78,0xf0,0x30,0xc0,0x10,0x80,0x08,0x80,0x05,0x00,0x03,0x00,0x01,0x00,0x01,0x00};
static const unsigned char PROGMEM image_weather_humidity_bits[] = {0x00,0x30,0x00,0x00,0x30,0x00,0x00,0x30,0x00,0x00,0x30,0x00,0x00,0xf0,0x00,0x00,0xf0,0x00,0x00,0xfc,0x00,0x00,0xfc,0x00,0x03,0xfc,0x00,0x03,0xfc,0x00,0x03,0xff,0x00,0x03,0xff,0x00,0x0f,0xff,0xc0,0x0f,0xff,0xc0,0x0f,0xff,0xc0,0x0f,0xff,0xc0,0x3f,0xfc,0xf0,0x3f,0xfc,0xf0,0x3f,0xff,0x30,0x3f,0xff,0x30,0xff,0xff,0x3c,0xff,0xff,0x3c,0xff,0xff,0xfc,0xff,0xff,0xfc,0x3f,0xff,0xf0,0x3f,0xff,0xf0,0x3f,0xff,0xf0,0x3f,0xff,0xf0,0x0f,0xff,0xc0,0x0f,0xff,0xc0,0x00,0xff,0x00,0x00,0xff,0x00};
static const unsigned char PROGMEM image_weather_temperature_bits[] = {0x03,0xf0,0x00,0x00,0x03,0xf0,0x00,0x00,0x0c,0x0c,0x00,0x0c,0x0c,0x0c,0x00,0x0c,0x0c,0xcf,0x00,0x33,0x0c,0xcf,0x00,0x33,0x0c,0xcc,0x00,0x0c,0x0c,0xcc,0x00,0x0c,0x0c,0xcf,0x0f,0xc0,0x0c,0xcf,0x0f,0xc0,0x0c,0xcc,0x3c,0x00,0x0c,0xcc,0x3c,0x00,0x0c,0xcf,0x30,0x00,0x0c,0xcf,0x30,0x00,0x0c,0xcc,0x30,0x00,0x0c,0xcc,0x30,0x00,0x0c,0xcc,0x3c,0x00,0x0c,0xcc,0x3c,0x00,0x30,0xc3,0x0f,0xc0,0x30,0xc3,0x0f,0xc0,0xc3,0xf0,0xc0,0x00,0xc3,0xf0,0xc0,0x00,0xcc,0xfc,0xc0,0x00,0xcc,0xfc,0xc0,0x00,0xcf,0xfc,0xc0,0x00,0xcf,0xfc,0xc0,0x00,0xc3,0xf0,0xc0,0x00,0xc3,0xf0,0xc0,0x00,0x30,0x03,0x00,0x00,0x30,0x03,0x00,0x00,0x0f,0xfc,0x00,0x00,0x0f,0xfc,0x00,0x00};
static const unsigned char PROGMEM image_wifi_full_bits[] = {0x01,0xf0,0x00,0x07,0xfc,0x00,0x1e,0x0f,0x00,0x39,0xf3,0x80,0x77,0xfd,0xc0,0xef,0x1e,0xe0,0x5c,0xe7,0x40,0x3b,0xfb,0x80,0x17,0x1d,0x00,0x0e,0xee,0x00,0x05,0xf4,0x00,0x03,0xb8,0x00,0x01,0x50,0x00,0x00,0xe0,0x00,0x00,0x40,0x00,0x00,0x00,0x00};

// Structure Keypad Numpad
struct Key { int x; int y; int w; int h; char label[8]; };

Key keys[] = {
  {10,  70,  65, 36, "1"}, {85,  70,  65, 36, "2"}, {160, 70,  65, 36, "3"}, {235, 70,  75, 36, "DEL"},
  {10,  112, 65, 36, "4"}, {85,  112, 65, 36, "5"}, {160, 112, 65, 36, "6"}, {235, 112, 75, 36, "CLR"},
  {10,  154, 65, 36, "7"}, {85,  154, 65, 36, "8"}, {160, 154, 65, 36, "9"}, {235, 154, 75, 36, "ESC"},
  {10,  196, 65, 36, "."}, {85,  196, 65, 36, "0"}, {160, 196, 150,36, "OK"}
};
const int numKeys = sizeof(keys) / sizeof(keys[0]);

// Setup Fuzzy Logic Mamdani Kontrol Suhu Peltier
void initFuzzy() {
  FuzzyInput *errTemp = new FuzzyInput(1);
  FuzzySet *tDingin = new FuzzySet(-10, -10, -2.0, 0);
  FuzzySet *tNormal = new FuzzySet(-0.5, 0, 0, 0.5);
  FuzzySet *tPanas  = new FuzzySet(0, 1.0, 10, 10);
  errTemp->addFuzzySet(tDingin); errTemp->addFuzzySet(tNormal); errTemp->addFuzzySet(tPanas);
  fuzzy->addFuzzyInput(errTemp);

  FuzzyOutput *peltier = new FuzzyOutput(1);
  FuzzySet *pHeat = new FuzzySet(-255, -255, -255, 0);
  FuzzySet *pOff  = new FuzzySet(-2, 0, 0, 2);
  FuzzySet *pCool = new FuzzySet(0, 255, 255, 255);
  peltier->addFuzzySet(pHeat); peltier->addFuzzySet(pOff); peltier->addFuzzySet(pCool);
  fuzzy->addFuzzyOutput(peltier);

  auto addRule = [&](int id, FuzzySet* in, FuzzySet* out) {
    FuzzyRuleAntecedent *ant = new FuzzyRuleAntecedent(); ant->joinSingle(in);
    FuzzyRuleConsequent *con = new FuzzyRuleConsequent(); con->addOutput(out);
    fuzzy->addFuzzyRule(new FuzzyRule(id, ant, con));
  };

  // RULES FUZZY LOGIC MAMDANI
  addRule(1, tPanas, pCool);   // IF Suhu Panas  THEN Output Peltier Cool (0..255)
  addRule(2, tNormal, pOff);   // IF Suhu Normal THEN Output Peltier Off (0)
  addRule(3, tDingin, pHeat);  // IF Suhu Dingin THEN Output Peltier Heat (-255..0)
}

// FUNGSI PENGATURAN PWM PELTIER (SECARA PRESISI VIA DRIVER BTS7960)
void setPeltierPower(int val) {
  val = constrain(val, -255, 255);
  if (val > 0) { 
    // Mode Cooling: RPWM di-outputkan PWM (0..255), LPWM = 0
    ledcWrite(PIN_RPWM, val); 
    ledcWrite(PIN_LPWM, 0); 
  }
  else if (val < 0) { 
    // Mode Heating: LPWM di-outputkan PWM (0..255), RPWM = 0
    ledcWrite(PIN_RPWM, 0); 
    ledcWrite(PIN_LPWM, abs(val)); 
  }
  else { 
    // Mode Stop: Kedua PWM diset 0
    ledcWrite(PIN_RPWM, 0); 
    ledcWrite(PIN_LPWM, 0); 
  }
}

void updateDynamicValues() {
  if (keyboardState != 0) return;

  tft.setTextColor(0xFFFF, 0x0);
  tft.setFreeFont(&FreeSansBoldOblique24pt7b);

  tft.fillRect(47, 86, 105, 40, 0x0);
  tft.drawString(String((int)tempSensor) + " °C", 47, 86);
  tft.fillRect(46, 150, 105, 40, 0x0);
  tft.drawString(String((int)rhSensor) + "%", 46, 150);

  tft.fillRect(208, 86, 105, 40, 0x0);
  tft.drawString(String((int)setpointTemp) + " °C", 208, 86);
  tft.fillRect(207, 150, 105, 40, 0x0);
  tft.drawString(String((int)setpointRH) + "%", 207, 150);
}

void drawMainUI() {
  tft.fillScreen(0x0);

  tft.setTextColor(0xFC00);
  tft.setFreeFont(&FreeMonoBold12pt7b);
  tft.drawString("Growth Chamber ", 9, 7);
  tft.drawBitmap(213, 9, image_plant_bits, 16, 16, 0x4B1);

  tft.drawRect(5, 36, 150, 204, 0xFFFF);
  tft.drawRect(166, 36, 150, 204, 0xFFFF);

  tft.setTextColor(0xFC00);
  tft.setFreeFont(&FreeSans12pt7b);
  tft.drawString("Sensor", 15, 45);
  tft.drawString("Set Point", 178, 47);

  tft.drawBitmap(12, 94, image_weather_temperature_bits, 32, 32, 0xF206);
  tft.drawBitmap(12, 155, image_weather_humidity_bits, 22, 32, 0x24BE);
  tft.drawBitmap(173, 94, image_weather_temperature_bits, 32, 32, 0xF206);
  tft.drawBitmap(173, 155, image_weather_humidity_bits, 22, 32, 0x24BE);

  tft.drawBitmap(15, 213, image_wifi_full_bits, 19, 16, wifiOnline ? 0x07E0 : 0x7BEF);
  
  // Tombol Play: Ungu saat Running, Cyan saat Standby
  tft.drawBitmap(277, 200, image_music_play_button_bits, 30, 32, systemRunning ? TFT_PURPLE : 0x4B1);

  updateDynamicValues();
}

void drawKeyboardPopup() {
  tft.fillScreen(TFT_BLACK);
  
  tft.fillRect(0, 0, 320, 26, TFT_NAVY);
  tft.setTextColor(TFT_WHITE, TFT_NAVY);
  tft.setFreeFont(&FreeSans12pt7b);
  tft.drawString(keyboardState == 1 ? "SETPOINT SUHU (C)" : "SETPOINT RH (%)", 10, 3);

  tft.fillRoundRect(10, 30, 300, 32, 4, TFT_WHITE);
  tft.setTextColor(TFT_BLACK, TFT_WHITE);
  tft.drawString(keyboardBuffer + "_", 20, 34);

  for (int i = 0; i < numKeys; i++) {
    uint16_t keyColor = TFT_DARKGREY;
    if (String(keys[i].label) == "OK") keyColor = TFT_GREEN;
    else if (String(keys[i].label) == "ESC" || String(keys[i].label) == "CLR") keyColor = TFT_RED;
    else if (String(keys[i].label) == "DEL") keyColor = TFT_ORANGE;

    tft.fillRoundRect(keys[i].x, keys[i].y, keys[i].w, keys[i].h, 5, keyColor);
    tft.drawRoundRect(keys[i].x, keys[i].y, keys[i].w, keys[i].h, 5, TFT_WHITE);
    
    tft.setTextColor(TFT_WHITE, keyColor);
    tft.drawCentreString(keys[i].label, keys[i].x + (keys[i].w / 2), keys[i].y + 6, 2);
  }
}

bool checkArea(int x, int y, int bx, int by, int bw, int bh) {
  return (x >= bx && x <= (bx + bw) && y >= by && y <= (by + bh));
}

#include "platform_transport.h"

void setup() {
  Serial.begin(115200);

  // Inisialisasi Pin Relay Mist Maker (Active HIGH)
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, LOW); // LOW = Mati diawal

  // Inisialisasi PWM BTS7960
  ledcAttach(PIN_RPWM, 5000, 8);
  ledcAttach(PIN_LPWM, 5000, 8);
  setPeltierPower(0);

  tft.init();
  tft.setRotation(1);
  
  uint16_t calData[5] = { 580, 3164, 385, 3197, 7 };
  tft.setTouch(calData); 

  Wire.begin(21, 22);
  sht31.begin(SHT31_ADDR);
  initFuzzy();
  Platform::begin();

  drawMainUI();
}

void loop() {
  Platform::tick();
  // 1. READER SENSOR, KONTROL PWM PELTIER & MIST MAKER
  if (millis() - lastSensRead > 1500) {
    tempSensor = sht31.readTemperature();
    rhSensor   = sht31.readHumidity();

    if (systemRunning && !isnan(tempSensor) && !isnan(rhSensor)) {
      
      // A. KONTROL SUHU (FUZZY LOGIC MAMDANI -> PWM PELTIER)
      float errorTemp = tempSensor - setpointTemp;
      fuzzy->setInput(1, errorTemp);
      fuzzy->fuzzify();
      int outPeltier = (int)fuzzy->defuzzify(1);
      setPeltierPower(outPeltier); // Mengirim daya PWM (-255 s/d 255)

      // B. KONTROL KELEMBAPAN (ACTIVE HIGH RELAY PIN 32)
      if (rhSensor < setpointRH) {
        digitalWrite(PIN_RELAY, HIGH); // RH Kurang -> RELAY MENYALA (HIGH)
      } else {
        digitalWrite(PIN_RELAY, LOW);  // RH Tercapai -> RELAY MATI (LOW)
      }

    } else {
      // Jika Sistem STOP / Idle
      setPeltierPower(0);
      digitalWrite(PIN_RELAY, LOW);    // RELAY MATI (LOW)
    }

    updateDynamicValues();
    lastSensRead = millis();
  }

  // 2. TOUCH SCREEN ENGINE
  uint16_t x = 0, y = 0;
  bool pressed = tft.getTouch(&x, &y);

  if (pressed && (millis() - lastTouch > 200)) {
    lastTouch = millis();

    if (keyboardState == 0) {
      // Sentuh Set Point Suhu
      if (checkArea(x, y, 166, 36, 150, 90)) {
        keyboardState = 1; 
        keyboardBuffer = "";
        drawKeyboardPopup();
      } 
      // Sentuh Set Point RH
      else if (checkArea(x, y, 166, 130, 145, 60)) {
        keyboardState = 2; 
        keyboardBuffer = "";
        drawKeyboardPopup();
      } 
      // SENTUH TOMBOL PLAY / STOP
      else if (checkArea(x, y, 260, 195, 55, 40)) {
        systemRunning = !systemRunning;

        if (systemRunning) {
          drawMainUI();

          // Trigger Tes Awal: Relay Menyala 1 Detik (Active HIGH)
          digitalWrite(PIN_RELAY, HIGH);
          delay(1000); 
          digitalWrite(PIN_RELAY, LOW);
        } else {
          digitalWrite(PIN_RELAY, LOW);
          setPeltierPower(0);
          drawMainUI();
        }
      }
      // Sentuh Icon Wi-Fi
      else if (checkArea(x, y, 5, 200, 50, 40)) {
        wifiOnline = !wifiOnline;
        drawMainUI();
      }
    } 
    else {
      for (int i = 0; i < numKeys; i++) {
        if (checkArea(x, y, keys[i].x, keys[i].y, keys[i].w, keys[i].h)) {
          String lbl = String(keys[i].label);

          if (lbl == "OK") {
            if (keyboardBuffer.length() > 0) {
              if (keyboardState == 1) setpointTemp = keyboardBuffer.toFloat();
              else if (keyboardState == 2) setpointRH = keyboardBuffer.toFloat();
            }
            keyboardState = 0; 
            drawMainUI();
          } 
          else if (lbl == "ESC") {
            keyboardState = 0; 
            drawMainUI();
          } 
          else if (lbl == "CLR") {
            keyboardBuffer = "";
            drawKeyboardPopup();
          } 
          else if (lbl == "DEL") {
            if (keyboardBuffer.length() > 0) {
              keyboardBuffer.remove(keyboardBuffer.length() - 1);
              drawKeyboardPopup();
            }
          } 
          else {
            if (keyboardBuffer.length() < 5) {
              keyboardBuffer += lbl;
              drawKeyboardPopup();
            }
          }
          break;
        }
      }
    }
  }
}
