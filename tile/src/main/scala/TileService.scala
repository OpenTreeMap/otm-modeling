package org.opentreemap.modeling.tile

import geotrellis.raster._
import geotrellis.spark.op.stats._
import geotrellis.spark.utils._
import geotrellis.vector._

import org.apache.spark._

import scala.concurrent._

import spray.http.MediaTypes
import spray.http.StatusCodes
import spray.json._
import spray.json.JsonParser.ParsingException
import spray.routing.HttpService
import spray.routing.ExceptionHandler

import org.opentreemap.modeling._

trait TileService extends HttpService
                     with TileServiceLogic
                     with VectorHandling
                     with S3CatalogReading
                     with LayerMasking
                     with TileLayerMasking {
  import ModelingTypes._

  implicit def executionContext = actorRefFactory.dispatcher

  implicit val sparkContext = SparkUtils.createSparkContext("OTM Modeling Tile Service Context", new SparkConf())

  lazy val serviceRoute =
    handleExceptions(exceptionHandler) {
      breaksRoute ~
      weightedOverlayTileRoute
    }

  lazy val exceptionHandler = ExceptionHandler {
    case ex: ModelingException =>
      ex.printStackTrace(Console.err)
      complete(StatusCodes.InternalServerError, s"""{
          "status": "${StatusCodes.InternalServerError}",
          "statusCode": ${StatusCodes.InternalServerError.intValue},
          "message": "${ex.getMessage.replace("\"", "\\\"")}"
        } """)
    case ex =>
      ex.printStackTrace(Console.err)
      complete(StatusCodes.InternalServerError)
  }

  lazy val breaksRoute = path("gt" / "breaks") {
    post {
      formFields('bbox,
                 'layers,
                 'weights,
                 'numBreaks.as[Int],
                 'srid.as[Int],
                 'threshold.as[Int] ? NODATA,
                 'polyMask ? "",
                 'layerMask ? "") {
        (bbox, layersParam, weightsParam, numBreaks, srid, threshold,
            polyMaskParam, layerMaskParam) => {
          respondWithMediaType(MediaTypes.`application/json`) {
            complete {
              future {
                val extent = Extent.fromString(bbox)
                // TODO: Dynamic breaks based on configurable breaks resolution.

                val layers = layersParam.split(",")
                val weights = weightsParam.split(",").map(_.toInt)

                val parsedLayerMask = try {
                  import spray.json.DefaultJsonProtocol._
                  Some(layerMaskParam.parseJson.convertTo[LayerMaskType])
                } catch {
                  case ex: ParsingException =>
                    if (!layerMaskParam.isEmpty)
                      ex.printStackTrace(Console.err)
                    None
                }

                val polys = reprojectPolygons(
                  parsePolyMaskParam(polyMaskParam),
                  srid
                )

                val unmasked = weightedOverlay(implicitly, catalog, layers, weights, extent)
                val model = applyMasks(
                  unmasked,
                  polyMask(polys)
                  /*
                   TODO: Trying to use the land-use layer as a mask at
                   a lower zoom levels generated "empty collection"
                   exceptions. I suspect that the lower zoom versions
                   have interpolated values that don't match the
                   original, discrete values.
                   */
                  //layerMask(parseLayerMaskParam(implicitly, parsedLayerMask, extent, ModelingServiceSparkActor.BREAKS_ZOOM))
                )

                val breaks = model.classBreaks(numBreaks)
                if (breaks.size > 0 && breaks(0) == NODATA) {
                  s"""{ "error" : "Unable to calculate breaks (NODATA)."} """ //failWith(new ModelingException("Unable to calculate breaks (NODATA)."))
                } else {
                  val breaksArray = breaks.mkString("[", ",", "]")
                  s"""{ "classBreaks" : $breaksArray }"""
                }
              }
            }
          }
        }
      }
    }
  }

  lazy val weightedOverlayTileRoute = path("gt" / "tile"/ IntNumber / IntNumber / IntNumber ~ ".png" ) { (z, x, y) =>
    post {
      formFields('layers,
                 'weights,
                 'palette ? "ff0000,ffff00,00ff00,0000ff",
                 'breaks,
                 'srid.as[Int],
                 'colorRamp ? "blue-to-red",
                 'threshold.as[Int] ? NODATA,
                 'polyMask ? "",
                 'layerMask ? "") {
        (layersString, weightsString,
         palette, breaksString, srid, colorRamp, threshold,
         polyMaskParam, layerMaskParam) => {
          respondWithMediaType(MediaTypes.`image/png`) {
            complete {
              future {
                val layers = layersString.split(",")

                val weights = weightsString.split(",").map(_.toInt)
                val breaks = breaksString.split(",").map(_.toInt)

                val parsedLayerMask = try {
                  import spray.json.DefaultJsonProtocol._
                  Some(layerMaskParam.parseJson.convertTo[LayerMaskType])
                } catch {
                  case ex: ParsingException =>
                    if (!layerMaskParam.isEmpty)
                      ex.printStackTrace(Console.err)
                    None
                }

                val polys = reprojectPolygons(
                  parsePolyMaskParam(polyMaskParam),
                  srid
                )

                val unmasked = weightedOverlay(implicitly, catalog, layers, weights, z, x, y)
                val masked = applyTileMasks(
                  unmasked,
                  polyTileMask(polys),
                  layerTileMask(parseLayerTileMaskParam(implicitly, parsedLayerMask, z, x, y)),
                  thresholdTileMask(threshold)
                )

                val tile = renderTile(masked, breaks, colorRamp)
                tile.bytes
              }
            }
          }
        }
      }
    }
  }

}
