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
}

export function WeatherWidget() {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [date, setDate] = useState<Date>(new Date());

  useEffect(() => {
    // Update date every minute
    const dateInterval = setInterval(() => {
      setDate(new Date());
    }, 60000);

    // Reverse geocode to get location name
    const getReverseGeocode = async (
      lat: number,
      lon: number,
    ): Promise<string> => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
        );
        const data = await response.json();
        return (
          data.address?.city ||
          data.address?.town ||
          data.address?.village ||
          `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`
        );
      } catch {
        return `${lat.toFixed(1)}°, ${lon.toFixed(1)}°`;
      }
    };

    // Fetch weather data from Open-Meteo API
    const fetchWeather = async (
      lat: number,
      lon: number,
      locationName: string,
    ) => {
      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weathercode&temperature_unit=fahrenheit&timezone=auto`,
        );
        const data = await response.json();

        // Map weather codes to conditions
        const weatherCode = data.current.weathercode;
        const conditions: Record<number, string> = {
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

        setWeather({
          temperature: Math.round(data.current.temperature_2m),
          condition: conditions[weatherCode] || "Clear",
          location: locationName,
        });
      } catch (error) {
        console.error("Failed to fetch weather:", error);
        // Set a default weather state even if fetch fails
        setWeather({
          temperature: 72,
          condition: "Clear",
          location: locationName,
        });
      }
    };

    // Get user's location and fetch weather
    const getUserLocation = async () => {
      try {
        // Try browser geolocation first
        if ("geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              const lat = position.coords.latitude;
              const lon = position.coords.longitude;
              console.log(`[Weather] Got coordinates: ${lat}, ${lon}`);

              // Get location name first, then fetch weather
              const locationName = await getReverseGeocode(lat, lon);
              console.log(`[Weather] Location: ${locationName}`);
              await fetchWeather(lat, lon, locationName);
            },
            async (error) => {
              console.error("[Weather] Geolocation denied or failed:", error);
              // Fallback to IP-based geolocation via Gateway
              try {
                console.log(
                  "[Weather] Trying IP-based location via Gateway...",
                );

                const response = await gateway.send("geolocation:get-from-ip");

                if (response.success && response.data) {
                  const ipData = response.data as {
                    latitude: number;
                    longitude: number;
                    city: string;
                    region?: string;
                  };

                  const locationName = ipData.region
                    ? `${ipData.city}, ${ipData.region}`
                    : ipData.city;
                  console.log(`[Weather] Using IP location: ${locationName}`);
                  await fetchWeather(
                    ipData.latitude,
                    ipData.longitude,
                    locationName,
                  );
                } else {
                  throw new Error(response.error || "IP geolocation failed");
                }
              } catch (ipError) {
                console.error("[Weather] IP geolocation failed:", ipError);
                // Last resort: default location (New York)
                console.warn("[Weather] Using fallback location: New York");
                await fetchWeather(40.7128, -74.006, "New York");
              }
            },
            {
              enableHighAccuracy: false, // Changed to false for faster response
              timeout: 5000, // Reduced timeout
              maximumAge: 300000, // Cache for 5 minutes
            },
          );
        } else {
          // No geolocation support - use default
          console.log("[Weather] No geolocation support, using default");
          await fetchWeather(40.7128, -74.006, "New York");
        }
      } catch (error) {
        console.error("[Weather] Failed to get location:", error);
        // Fallback to default
        await fetchWeather(40.7128, -74.006, "New York");
      }
    };

    getUserLocation();
    const weatherInterval = setInterval(getUserLocation, 900000); // Every 15 minutes

    return () => {
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
            <div className="weather-widget__temp">{weather.temperature}°F</div>
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
