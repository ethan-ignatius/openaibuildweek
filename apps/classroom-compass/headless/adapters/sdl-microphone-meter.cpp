#include <SDL.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {
std::atomic<bool> running{true};
std::atomic<double> sumSquares{0.0};
std::atomic<unsigned long long> sampleCount{0};
std::atomic<float> peakLevel{0.0F};

void stop(int) { running = false; }

void capture(void*, Uint8* stream, int length) {
  const auto* samples = reinterpret_cast<const float*>(stream);
  const int count = length / static_cast<int>(sizeof(float));
  double localSquares = 0.0;
  float localPeak = 0.0F;
  for (int index = 0; index < count; ++index) {
    const float value = samples[index];
    localSquares += static_cast<double>(value) * value;
    localPeak = std::max(localPeak, std::abs(value));
  }
  sumSquares.fetch_add(localSquares, std::memory_order_relaxed);
  sampleCount.fetch_add(static_cast<unsigned long long>(count), std::memory_order_relaxed);
  float prior = peakLevel.load(std::memory_order_relaxed);
  while (localPeak > prior && !peakLevel.compare_exchange_weak(prior, localPeak, std::memory_order_relaxed)) {}
}
}  // namespace

int main(int argc, char** argv) {
  const std::string requested = argc > 1 ? argv[1] : "Logitech Webcam C925e";
  const int durationSeconds = argc > 2 ? std::max(1, std::atoi(argv[2])) : 10;
  if (SDL_Init(SDL_INIT_AUDIO) != 0) {
    std::cerr << "Unable to initialize audio: " << SDL_GetError() << "\n";
    return 2;
  }

  const int deviceCount = SDL_GetNumAudioDevices(SDL_TRUE);
  std::vector<std::string> deviceNames;
  for (int index = 0; index < deviceCount; ++index) {
    const char* name = SDL_GetAudioDeviceName(index, SDL_TRUE);
    std::cout << "Capture #" << index << ": " << (name ? name : "unknown") << "\n";
    if (name) deviceNames.emplace_back(name);
  }
  if (requested == "--list") {
    SDL_Quit();
    return 0;
  }
  std::vector<std::string> aliases;
  std::size_t start = 0;
  while (start <= requested.size()) {
    const std::size_t separator = requested.find('|', start);
    aliases.push_back(requested.substr(start, separator == std::string::npos ? std::string::npos : separator - start));
    if (separator == std::string::npos) break;
    start = separator + 1;
  }
  std::string selected;
  for (const auto& alias : aliases) {
    const auto match = std::find_if(deviceNames.begin(), deviceNames.end(), [&alias](const std::string& name) {
      return !alias.empty() && name.find(alias) != std::string::npos;
    });
    if (match != deviceNames.end()) {
      selected = *match;
      break;
    }
  }
  if (selected.empty()) {
    std::cerr << "None of the requested microphone aliases \"" << requested << "\" were found.\n";
    SDL_Quit();
    return 2;
  }

  SDL_AudioSpec desired{};
  SDL_AudioSpec obtained{};
  desired.freq = 16000;
  desired.format = AUDIO_F32SYS;
  desired.channels = 1;
  desired.samples = 1024;
  desired.callback = capture;
  const SDL_AudioDeviceID device = SDL_OpenAudioDevice(selected.c_str(), SDL_TRUE, &desired, &obtained, 0);
  if (device == 0) {
    std::cerr << "Unable to open " << selected << ": " << SDL_GetError() << "\n";
    SDL_Quit();
    return 2;
  }

  std::signal(SIGINT, stop);
  std::signal(SIGTERM, stop);
  std::cout << "\nMeasuring " << selected << " for " << durationSeconds
            << " seconds. Speak normally; no audio is recorded or saved.\n";
  SDL_PauseAudioDevice(device, 0);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(durationSeconds);
  while (running && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    const auto count = sampleCount.exchange(0, std::memory_order_relaxed);
    const double squares = sumSquares.exchange(0.0, std::memory_order_relaxed);
    const float peak = peakLevel.exchange(0.0F, std::memory_order_relaxed);
    const double rms = count ? std::sqrt(squares / static_cast<double>(count)) : 0.0;
    const double db = rms > 1e-9 ? 20.0 * std::log10(rms) : -90.0;
    const int bars = std::clamp(static_cast<int>((db + 60.0) / 2.5), 0, 24);
    std::cout << '[' << std::string(bars, '#') << std::string(24 - bars, ' ')
              << "] " << static_cast<int>(std::round(db)) << " dB RMS"
              << "  peak " << static_cast<int>(std::round(peak * 100.0F)) << "%\n";
  }

  SDL_CloseAudioDevice(device);
  SDL_Quit();
  return 0;
}
