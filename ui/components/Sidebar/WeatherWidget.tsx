/**
 * WeatherWidget - Displays date and weather info
 * Reference: Paprwork v1 index.html weather widget
 */

import React, { useEffect, useState } from "react";
import { gateway } from "../../src/lib/gateway";
import "./WeatherWidget.css";

interface WeatherData {
  temperature: number;
  condition: string;
  location: string;
  useFahrenheit: boolean;
}

interface GeoCoordinates {
  lat: number;
  lon: number;
}

interface IpGeolocationData {
  latitude: number;
  longitude: number;
  city: string;
  region?: string;
  country_code?: string;
}

const FALLBACK_COORDS: GeoCoordinates = { lat: 40.7128, lon: -74.006 };
const FALLBACK_LOCATION = "New York";
const PRECISE_LOCATION_FAILED_KEY = "papr.weather.preciseLocationFailed";

const fahrenheitCountries = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);

const weatherConditions: Record<number, string> = {
  0: "Clear",
  1: "Mainly Clear",
  2: "Partly Cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Foggy",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Heavy Rain",
  71: "Snow",
  73: "Snow",
  75: "Heavy Snow",
  95: "Thunderstorm",
};

function usesFahrenheit(countryCode: string): boolean {
  return fahrenheitCountries.has(countryCode.toUpperCase());
}

async function getReverseGeocode(
  lat: number,
  lon: number,
): Promise<{ name: string; countryCode: string }> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
    );
    const data = await response.json();
    const name =
      data.address?.city ||
      data.address?.town ||
      data.address?.village ||
      `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
    const countryCode = (data.address?.country_code || "").toUpperCase();
    return { name, countryCode };
  } catch {
    return { name: `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`, countryCode: "" };
  }
}

async function fetchWeatherForecast(
  lat: number,
  lon: number,
  locationName: string,
  useFahrenheit: boolean,
): Promise<WeatherData> {
  const unit = useFahrenheit ? "fahrenheit" : "celsius";
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode&temperature_unit=${unit}&timezone=auto`,
  );
  const data = await response.json();
  const weatherCode = data.current.weathercode as number;

  return {
    temperature: Math.round(data.current.temperature_2m),
    condition: weatherConditions[weatherCode] || "Clear",
    location: locationName,
    useFahrenheit,
  };
}

async function fetchWeatherFromIp(): Promise<WeatherData> {
  const response = await gateway.send("geolocation:get-from-ip");
  if (!response.success || !response.data) {
    throw new Error(response.error || "IP geolocation failed");
  }

  const ipData = response.data as IpGeolocationData;
  const locationName = ipData.region
    ? `${ipData.city}, ${ipData.region}`
    : ipData.city;
  const countryCode = (ipData.country_code || "").toUpperCase();

  return fetchWeatherForecast(
    ipData.latitude,
    ipData.longitude,
    locationName,
    usesFahrenheit(countryCode),
  );
}

function logGeolocationFallback(error: GeolocationPositionError): void {
  if (error.code === error.PERMISSION_DENIED) {
    console.log(
      "[Weather] Location permission not granted, using approximate location",
    );
    return;
  }

  if (error.code === error.TIMEOUT) {
    console.log("[Weather] Location timed out, using approximate location");
    return;
  }

  console.log("[Weather] Location unavailable, using approximate location");
}

async function tryBrowserGeolocation(): Promise<GeoCoordinates | null> {
  if (!("geolocation" in navigator)) {
    return null;
  }

  if (sessionStorage.getItem(PRECISE_LOCATION_FAILED_KEY) === "1") {
    return null;
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        sessionStorage.removeItem(PRECISE_LOCATION_FAILED_KEY);
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        });
      },
      (error) => {
        logGeolocationFallback(error);
        if (
          error.code === error.TIMEOUT ||
          error.code === error.POSITION_UNAVAILABLE
        ) {
          sessionStorage.setItem(PRECISE_LOCATION_FAILED_KEY, "1");
        }
        resolve(null);
      },
      {
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 300_000,
      },
    );
  });
}

async function resolveWeatherData(): Promise<WeatherData> {
  const browserCoords = await tryBrowserGeolocation();
  if (browserCoords) {
    const geo = await getReverseGeocode(browserCoords.lat, browserCoords.lon);
    return fetchWeatherForecast(
      browserCoords.lat,
      browserCoords.lon,
      geo.name,
      usesFahrenheit(geo.countryCode),
    );
  }

  try {
    return await fetchWeatherFromIp();
  } catch {
    console.log("[Weather] Using fallback location:", FALLBACK_LOCATION);
    return fetchWeatherForecast(
      FALLBACK_COORDS.lat,
      FALLBACK_COORDS.lon,
      FALLBACK_LOCATION,
      true,
    );
  }
}

export function WeatherWidget() {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [date, setDate] = useState<Date>(new Date());

  useEffect(() => {
    const dateInterval = setInterval(() => {
      setDate(new Date());
    }, 60_000);

    let cancelled = false;

    const loadWeather = async () => {
      try {
        const nextWeather = await resolveWeatherData();
        if (!cancelled) {
          setWeather(nextWeather);
        }
      } catch (error) {
        console.error("[Weather] Failed to load weather:", error);
        if (!cancelled) {
          setWeather({
            temperature: 72,
            condition: "Clear",
            location: FALLBACK_LOCATION,
            useFahrenheit: true,
          });
        }
      }
    };

    void loadWeather();
    const weatherInterval = setInterval(() => {
      void loadWeather();
    }, 900_000);

    return () => {
      cancelled = true;
      clearInterval(dateInterval);
      clearInterval(weatherInterval);
    };
  }, []);

  const formatDate = (d: Date) => {
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
  };

  const getWeatherIcon = () => {
    if (!weather) return "☁️";
    const code = weather.condition.toLowerCase();
    if (code.includes("clear") || code.includes("sun")) return "☀️";
    if (code.includes("cloud")) return "☁️";
    if (code.includes("rain")) return "🌧️";
    if (code.includes("snow")) return "❄️";
    if (code.includes("thunder")) return "⛈️";
    if (code.includes("fog")) return "🌫️";
    return "☁️";
  };

  return (
    <div className="weather-widget">
      <div className="weather-widget__date">{formatDate(date)}</div>
      {weather && (
        <div className="weather-widget__info">
          <div className="weather-widget__left">
            <div className="weather-widget__temp">
              {weather.temperature}°{weather.useFahrenheit ? "F" : "C"}
            </div>
            <div className="weather-widget__location">{weather.location}</div>
          </div>
          <div className="weather-widget__right">
            <span className="weather-widget__icon">{getWeatherIcon()}</span>
            <div className="weather-widget__condition">{weather.condition}</div>
          </div>
        </div>
      )}
    </div>
  );
}
