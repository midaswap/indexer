/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { edb } from "@/common/db";
import { logger } from "@/common/logger";
import { formatEth, fromBuffer, toBuffer } from "@/common/utils";
import { CollectionSets } from "@/models/collection-sets";

const version = "v4";

export const getCollectionsV4Options: RouteOptions = {
  description: "Get a filtered list of collections",
  notes:
    "Useful for getting multiple collections to show in a marketplace, or search for particular collections.",
  tags: ["api", "4. NFT API"],
  plugins: {
    "hapi-swagger": {
      order: 12,
    },
  },
  validate: {
    query: Joi.object({
      collectionsSetId: Joi.string()
        .lowercase()
        .description("Filter to a particular collection set"),
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community, e.g. `artblocks`"),
      contract: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .description(
          "Filter to a particular contract, e.g. `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
        ),
      name: Joi.string()
        .lowercase()
        .description("Search for collections that match a string, e.g. `bored`"),
      slug: Joi.string()
        .lowercase()
        .description("Filter to a particular slug, e.g. `boredapeyachtclub`"),
      sortBy: Joi.string()
        .valid("1DayVolume", "7DayVolume", "30DayVolume", "allTimeVolume")
        .default("allTimeVolume"),
      includeTopBid: Joi.boolean().default(false),
      limit: Joi.number().integer().min(1).max(20).default(20),
      continuation: Joi.string(),
    }).or("collectionsSetId", "community", "contract", "name", "sortBy"),
  },
  response: {
    schema: Joi.object({
      continuation: Joi.string().allow(null),
      collections: Joi.array().items(
        Joi.object({
          id: Joi.string(),
          slug: Joi.string().allow(null, ""),
          name: Joi.string().allow(null, ""),
          image: Joi.string().allow(null, ""),
          banner: Joi.string().allow(null, ""),
          discordUrl: Joi.string().allow(null, ""),
          externalUrl: Joi.string().allow(null, ""),
          twitterUsername: Joi.string().allow(null, ""),
          description: Joi.string().allow(null, ""),
          sampleImages: Joi.array().items(Joi.string().allow(null, "")),
          tokenCount: Joi.string(),
          tokenSetId: Joi.string().allow(null),
          primaryContract: Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{40}$/),
          floorAskPrice: Joi.number().unsafe().allow(null),
          topBidValue: Joi.number().unsafe().allow(null),
          topBidMaker: Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{40}$/)
            .allow(null),
          rank: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
            allTime: Joi.number().unsafe().allow(null),
          }),
          volume: Joi.object({
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
            allTime: Joi.number().unsafe().allow(null),
          }),
          volumeChange: {
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
          },
          floorSale: {
            "1day": Joi.number().unsafe().allow(null),
            "7day": Joi.number().unsafe().allow(null),
            "30day": Joi.number().unsafe().allow(null),
          },
        })
      ),
    }).label(`getCollections${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-collections-${version}-handler`, `Wrong response schema: ${error}`);

      throw error;
    },
  },
  handler: async (request: Request) => {
    let collections = [] as any;
    const query = request.query as any;

    try {
      let baseQuery = `
        SELECT
          collections.id,
          collections.slug,
          collections.name,
          (collections.metadata ->> 'imageUrl')::TEXT AS "image",
          (collections.metadata ->> 'bannerImageUrl')::TEXT AS "banner",
          (collections.metadata ->> 'discordUrl')::TEXT AS "discord_url",
          (collections.metadata ->> 'description')::TEXT AS "description",
          (collections.metadata ->> 'externalUrl')::TEXT AS "external_url",
          (collections.metadata ->> 'twitterUsername')::TEXT AS "twitter_username",
          collections.contract,
          collections.token_set_id,
          collections.token_count,
          (
            SELECT array(
              SELECT tokens.image FROM tokens
              WHERE tokens.collection_id = collections.id
              LIMIT 4
            )
          ) AS sample_images,
          collections.floor_sell_value,
          collections.day1_volume,
          collections.day7_volume,
          collections.day30_volume,
          collections.all_time_volume,
          collections.day1_rank,
          collections.day7_rank,
          collections.day30_rank,
          collections.all_time_rank,
          collections.day1_volume_change,
          collections.day7_volume_change,
          collections.day30_volume_change,
          collections.day1_floor_sell_value,
          collections.day7_floor_sell_value,
          collections.day30_floor_sell_value
        FROM collections
      `;

      // Filters
      const conditions: string[] = [];
      if (query.community) {
        conditions.push(`collections.community = $/community/`);
      }

      if (query.collectionsSetId) {
        const collectionsIds = await CollectionSets.getCollectionsIds(query.collectionsSetId);

        if (!_.isEmpty(collectionsIds)) {
          query.collectionsIds = _.join(collectionsIds, "','");
          conditions.push(`collections.id IN ('$/collectionsIds:raw/')`);
        }
      }

      if (query.contract) {
        query.contract = toBuffer(query.contract);
        conditions.push(`collections.contract = $/contract/`);
      }

      if (query.name) {
        query.name = `%${query.name}%`;
        conditions.push(`collections.name ILIKE $/name/`);
      }

      if (query.slug) {
        conditions.push(`collections.slug = $/slug/`);
      }

      let orderBy = ` ORDER BY collections.all_time_volume DESC NULLS LAST`;

      // Sorting
      switch (query.sortBy) {
        case "1DayVolume":
          if (query.continuation) {
            conditions.push(`collections.day1_volume < $/continuation/`);
          }

          orderBy = ` ORDER BY collections.day1_volume DESC NULLS LAST`;
          break;

        case "7DayVolume":
          if (query.continuation) {
            conditions.push(`collections.day7_volume < $/continuation/`);
          }

          orderBy = ` ORDER BY collections.day7_volume DESC NULLS LAST`;
          break;

        case "30DayVolume":
          if (query.continuation) {
            conditions.push(`collections.day30_volume < $/continuation/`);
          }

          orderBy = ` ORDER BY collections.day30_volume DESC NULLS LAST`;
          break;

        case "allTimeVolume":
        default:
          if (query.continuation) {
            conditions.push(`collections.all_time_volume < $/continuation/`);
          }
          break;
      }

      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      baseQuery += orderBy;

      // Pagination
      baseQuery += ` LIMIT $/limit/`;

      let topBidQuery = "";
      if (query.includeTopBid) {
        topBidQuery = `LEFT JOIN LATERAL (
          SELECT
            token_sets.top_buy_value,
            token_sets.top_buy_maker
          FROM token_sets
          WHERE token_sets.id = x.token_set_id
          ORDER BY token_sets.top_buy_value DESC
          LIMIT 1
        ) y ON TRUE`;
      }

      baseQuery = `
        WITH x AS (${baseQuery})
        SELECT *
        FROM x
        ${topBidQuery}
      `;

      const result = await edb.manyOrNone(baseQuery, query);

      if (result) {
        collections = result.map((r) => {
          const response = {
            id: r.id,
            slug: r.slug,
            name: r.name,
            image: r.image || (r.sample_images?.length ? r.sample_images[0] : null),
            banner: r.banner,
            discordUrl: r.discord_url,
            externalUrl: r.external_url,
            twitterUsername: r.twitter_username,
            description: r.description,
            sampleImages: r.sample_images || [],
            tokenCount: String(r.token_count),
            primaryContract: fromBuffer(r.contract),
            tokenSetId: r.token_set_id,
            floorAskPrice: r.floor_sell_value ? formatEth(r.floor_sell_value) : null,
            rank: {
              "1day": r.day1_rank,
              "7day": r.day7_rank,
              "30day": r.day30_rank,
              allTime: r.all_time_rank,
            },
            volume: {
              "1day": r.day1_volume ? formatEth(r.day1_volume) : null,
              "7day": r.day7_volume ? formatEth(r.day7_volume) : null,
              "30day": r.day30_volume ? formatEth(r.day30_volume) : null,
              allTime: r.all_time_volume ? formatEth(r.all_time_volume) : null,
            },
            volumeChange: {
              "1day": r.day1_volume_change,
              "7day": r.day7_volume_change,
              "30day": r.day30_volume_change,
            },
            floorSale: {
              "1day": r.day1_floor_sell_value ? formatEth(r.day1_floor_sell_value) : null,
              "7day": r.day7_floor_sell_value ? formatEth(r.day7_floor_sell_value) : null,
              "30day": r.day30_floor_sell_value ? formatEth(r.day30_floor_sell_value) : null,
            },
          };

          if (query.includeTopBid) {
            (response as any).topBidValue = r.top_buy_value ? formatEth(r.top_buy_value) : null;
            (response as any).topBidMaker = r.top_buy_maker ? fromBuffer(r.top_buy_maker) : null;
          }

          return response;
        });
      }

      // Set the continuation
      let continuation = null;
      if (result.length === query.limit) {
        const lastCollection = _.last(result);

        if (lastCollection) {
          switch (query.sortBy) {
            case "1DayVolume":
              continuation = lastCollection.day1_volume;
              break;

            case "7DayVolume":
              continuation = lastCollection.day7_volume;
              break;

            case "30DayVolume":
              continuation = lastCollection.day30_volume;
              break;

            case "allTimeVolume":
            default:
              continuation = lastCollection.all_time_volume;
              break;
          }
        }
      }

      return { collections, continuation };
    } catch (error) {
      logger.error(`get-collections-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
