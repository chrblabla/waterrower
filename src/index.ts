import mqtt, { MqttClient } from "mqtt"
import { SerialPort } from "serialport"
import { PortInfo } from "@serialport/bindings-interface"
import * as fs from "fs"

type Metric = "distance" | "power" | "total_cycles" | "speed" | "cadence" | "split"
type Unit = "m" | "watts" | "cycles" | "m/s" | "spm" | "s/500 m"

type Measurement = {
  value: number,
  unit: Unit,
  metric: Metric
}

const GARMIN_EPOCH = 631065600
const MQTT_TOPIC = "waterrower"

class WaterRowerS4 {
  private waterRower: PortInfo | null
  private port: SerialPort
  private activityTimeout: NodeJS.Timeout
  private lastStrokeTimestamp: EpochTimeStamp
  private recordingInterval: NodeJS.Timeout
  private fitTimestampStart = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
  private mqttClient: MqttClient
  private fileWriter: fs.WriteStream

  private distance: Measurement = { metric: "distance", unit: "m", value: 0 }
  private power: Measurement = { metric: "power", unit: "watts", value: 0 }
  private strokes: Measurement = { metric: "total_cycles", unit: "cycles", value: 0 }
  private speed: Measurement = { metric: "speed", unit: "m/s", value: 0 }
  private cadence: Measurement = { metric: "cadence", unit: "spm", value: 0 }
  private split: Measurement = { metric: "split", unit: "s/500 m", value: 0}

  constructor() {
    // Set up connection to MQTT for the dashboard
    this.mqttClient = mqtt.connect("mqtt://localhost")
  }

  start = async () => {
    if (!this.port) {
      // Set up connection to WaterRower
      this.waterRower = await this.findDevice()

      if (!this.waterRower) {
        console.error("No WaterRower found. Please check the USB connection.")
        return
      }

      this.port = new SerialPort({
        path: this.waterRower.path,
        baudRate: 115200,
      })
    }

    this.distance.value = 0
    this.power.value = 0
    this.strokes.value = 0
    this.speed.value = 0
    this.cadence.value = 0
    this.split.value = 0

    this.port.on("data", this.onData)

    this.send("USB")
  }

  openFile = () => {
    const now = Date.now()
    this.fitTimestampStart = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
    this.fileWriter = fs.createWriteStream(`trainings/${now}.fit.csv`)
    this.fileWriter.write("Type,Local Number,Message,Field 1,Value 1,Units 1,Field 2,Value 2,Units 2,Field 3,Value 3,Units 3,Field 4,Value 4,Units 4,Field 5,Value 5,Units 5\n")
    this.fileWriter.write("Definition,0,file_id,serial_number,1,,time_created,1,,manufacturer,1,,type,1,\n")
    this.fileWriter.write(`Data,0,file_id,serial_number,\"${this.fitTimestampStart}\",,time_created,\"${this.fitTimestampStart}\",,manufacturer,\"118\",,type,\"4\",\n`)
    this.fileWriter.write("Definition,1,record,timestamp,1,,distance,1,,power,1,,cadence,1,,speed,1,,total_cycles,1,,\n")
    this.fileWriter.write("Definition,2,session,timestamp,1,,start_time,1,,total_elapsed_time,1,total_distance,1,,total_cycles,1,,sport,1,,sub_sport,1,\n")
    this.fileWriter.write("Definition,3,activity,timestamp,1,,num_sessions,1,\n")
  }

  closeFile = () => {
    const fitTimestampEnd = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
    const sessionDuration = fitTimestampEnd - this.fitTimestampStart

    this.fileWriter.write(`Data,2,session,timestamp,\"${this.fitTimestampStart}\",s,start_time,\"${this.fitTimestampStart}\",,`)
    this.fileWriter.write(`total_elapsed_time,\"${sessionDuration}\",s,`)
    this.fileWriter.write(`total_distance,\"${this.distance.value}\",m,`)
    this.fileWriter.write(`total_cycles,\"${this.strokes.value}\",cycles,`)
    this.fileWriter.write("sport,\"15\",,sub_sport,\"14\",\n")

    this.fileWriter.write(`Data,3,activity,timestamp,\"${this.fitTimestampStart}\",,num_sessions,\"1\",\n`)
  }

  stop = (exit: boolean) => {
    // stop recording
    if (this.port) {
      this.port.off("data", this.onData)
    }

    if (this.recordingInterval) {
      clearInterval(this.recordingInterval)
      this.recordingInterval = null
    }

    if (this.lastStrokeTimestamp) {
      clearInterval(this.lastStrokeTimestamp)
      this.lastStrokeTimestamp = null
    }

    console.log("Finalizing workout file")

    // finalize workout file
    const fitTimestampEnd = Math.floor(Date.now() / 1000) - GARMIN_EPOCH
    const sessionDuration = fitTimestampEnd - this.fitTimestampStart
    this.fileWriter.write(`Data,2,session,timestamp,\"${this.fitTimestampStart}\",s,start_time,\"${this.fitTimestampStart}\",,`)
      this.fileWriter.write(`total_elapsed_time,\"${sessionDuration}\",s,`)
      this.fileWriter.write(`total_distance,\"${this.distance.value}\",m,`)
      this.fileWriter.write(`total_cycles,\"${this.strokes.value}\",cycles,`)
      this.fileWriter.write("sport,\"15\",,sub_sport,\"14\",\n")
    this.fileWriter.write(`Data,3,activity,timestamp,\"${this.fitTimestampStart}\",,num_sessions,\"1\",\n`)
    this.fileWriter.close(() => {
      if (exit) {
        process.exit()
      }
    })
  }

  onData = (data: Buffer) => {
    const stringData = data.toString()

    if (stringData.startsWith("_WR_")) {
      this.send("IV?")
    }

    if (stringData.startsWith("IV4")) {
      const firmwareVersion = stringData.substring(3, 5) + "." + stringData.substring(5, 7)
      console.log("Using WaterRower S4 with firmware version", firmwareVersion)
    }

    if (stringData.startsWith("AKR")) {
      console.log("\nReset")
      clearInterval(this.recordingInterval)
      this.stop(false)
      this.start()
      return
    }

    // To keep things simple, there's a chain in which data gets queried:
    // Each receival of a stroke start (SS) triggers the following chain:
    // SS -> power -> stroke count
    // Additionally, the following data gets queried every 500 ms and triggers a chain in itself:
    // distance -> pace

    // Detecting Stroke Start to query for power
    if (stringData.startsWith("SS")) {
      // start recording if no recording is active
      // recording takes whichever data is available at any given second and saves it to file.
      if (!this.recordingInterval) {
        console.log("Starting new session")

        this.openFile()

        this.recordingInterval = setInterval(() => {
          this.record()
        }, 1000) // FIT files have a second-based resolution
      }

      // console.log("Stroke")
      process.stdout.write(".")

      this.parseAndPublishData("", "cadence") // calculate and update cadence

      this.send("IRD088") // query for power

      // if this is the first stroke, set timer for querying distance
      if (!this.activityTimeout) {
        this.activityTimeout = setInterval(() => {
          this.send("IRD057") // query for distance
        }, 500)
      }
    }

    // Power in W
    if (stringData.startsWith("IDD088")) {
      this.parseAndPublishData(stringData, "power")
      this.send("IRD140") // query for stroke count
    }

    // Stroke count
    if (stringData.startsWith("IDD140")) {
      this.parseAndPublishData(stringData, "total_cycles")
    }

    // Distance in m
    if (stringData.startsWith("IDD057")) {
      this.parseAndPublishData(stringData, "distance")
      this.send("IRD14A") // query for pace (cm/s avg)
    }

    // Pace in cm/s current avg
    if (stringData.startsWith("IDD14A")) {
      this.parseAndPublishData(stringData, "speed")
    }
  }

  private record = () => {
    const now = Date.now()
    const fitTimestamp = Math.floor(now / 1000) - GARMIN_EPOCH

    this.fileWriter.write(`Data,1,record,timestamp,"${fitTimestamp}",s,`)
    this.fileWriter.write(`${this.distance.metric},"${this.distance.value}",${this.distance.unit},`)
    this.fileWriter.write(`${this.power.metric},"${this.power.value}",${this.power.unit},`)
    this.fileWriter.write(`${this.strokes.metric},"${this.strokes.value}",${this.strokes.unit},`)
    this.fileWriter.write(`${this.speed.metric},"${this.speed.value}",${this.speed.unit},`)
    this.fileWriter.write(`${this.cadence.metric},"${this.cadence.value}",${this.cadence.unit},`)
    this.fileWriter.write("\n")
  }

  private publish = (measurement: Measurement) => {
    this.mqttClient.publish(`${MQTT_TOPIC}/${measurement.metric}`, measurement.value.toString())
  }

  private parseAndPublishData = (data: string, metric: Metric) => {
    const now = Date.now()
    const value = parseInt(data.substring(6, 10), 16) || 0

    if (metric === "distance") {
      this.distance.value = value
      this.publish(this.distance)
    } else if (metric === "power") {
      this.power.value = value
      this.publish(this.power)
    } else if (metric === "cadence") {
      if (this.lastStrokeTimestamp) {
        const msSinceLastStroke = now - this.lastStrokeTimestamp
        const cadence = parseFloat((60 * 1000 / msSinceLastStroke).toFixed(1))

        this.cadence.value = cadence
        this.publish(this.cadence)
      }

      this.lastStrokeTimestamp = now
    } else if (metric === "speed") {
      // Speed is delivered in cm/s which needs to converted to m/s
      this.speed.value = value / 100
      this.publish(this.speed)

      if (value !== 0) {
        // Calculate pace for 500 m
        const secondsPer500m = 50000 / value
        // const pacePer500m = `${Math.floor(secondsPer500m / 60)}:${Math.floor(secondsPer500m % 60).toString().padStart(2, '0')}`

        this.split.value = secondsPer500m
        this.publish(this.split)
      }
    } else if (metric === "total_cycles") {
      this.strokes.value = value
      this.publish(this.strokes)
    }
  }

  private send = (value: string) => {
    if (!this.port) {
      console.log("Communication needs to be initialized first.")
      return
    }

    this.port.write(value + "\r\n")
  }

  private findDevice = async (): Promise<PortInfo> => {
    const devices = await SerialPort.list()

    return devices.find((device) => {
      return device.vendorId === "04d8" && device.productId === "000a"
    })
  }
}

const waterRower = new WaterRowerS4()
process.once("SIGINT", () => {
  waterRower.stop(true)
})
await waterRower.start()
